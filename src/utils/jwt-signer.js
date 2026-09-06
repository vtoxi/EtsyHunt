// JWT Signer for Google Service Account Authentication
// Uses Web Crypto API (works in Chrome extension service workers)

export class JWTSigner {
  constructor(serviceAccountJSON) {
    this.clientEmail = serviceAccountJSON.client_email;
    this.privateKey = serviceAccountJSON.private_key;
    this.tokenUri = serviceAccountJSON.token_uri || 'https://oauth2.googleapis.com/token';
    this._cachedToken = null;
    this._tokenExpiry = 0;
  }

  // Base64url encode
  _base64url(data) {
    if (typeof data === 'string') {
      data = new TextEncoder().encode(data);
    }
    let binary = '';
    const bytes = new Uint8Array(data);
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Import PEM private key for signing
  async _importKey() {
    const pemContents = this.privateKey
      .replace(/-----BEGIN PRIVATE KEY-----/g, '')
      .replace(/-----END PRIVATE KEY-----/g, '')
      .replace(/\s/g, '');

    const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

    return crypto.subtle.importKey(
      'pkcs8',
      binaryDer.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
  }

  // Create and sign a JWT
  async _createJWT(scopes) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: this.clientEmail,
      scope: scopes.join(' '),
      aud: this.tokenUri,
      iat: now,
      exp: now + 3600
    };

    const headerB64 = this._base64url(JSON.stringify(header));
    const payloadB64 = this._base64url(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;

    const key = await this._importKey();
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(signingInput)
    );

    return `${signingInput}.${this._base64url(signature)}`;
  }

  // Get an access token (cached until near expiry)
  async getAccessToken(scopes = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive'
  ]) {
    if (this._cachedToken && Date.now() < this._tokenExpiry - 60000) {
      return this._cachedToken;
    }

    const jwt = await this._createJWT(scopes);
    const response = await fetch(this.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    this._cachedToken = data.access_token;
    this._tokenExpiry = Date.now() + (data.expires_in * 1000);
    return this._cachedToken;
  }
}
