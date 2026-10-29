// Etsy Search Results Extractor — Content Script
// Runs on: https://www.etsy.com/search*
// Extracts listing data from Etsy search result cards
//
// IMPORTANT: Rating & review count shown on search cards are SHOP-LEVEL metrics,
// not listing-specific. The aria-label "4.9 star rating with 31.4k reviews" refers
// to the shop's overall rating and total review count across all their listings.
// Fields are named shop_rating / shop_reviews to reflect this.

(function() {
  'use strict';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'extractEtsySearchResults') {
      handleExtractSearchResults(sendResponse);
      return true;
    }
    // 2026-08-19 (v2.0.0 NES discovery): probe Etsy's autosuggest from the page
    // origin. Runs here (not in the service worker) because the endpoint needs
    // the user's etsy.com session cookies + same-origin context — exactly how
    // the real search box calls it. Used by nes-discovery-workflow to validate
    // title-mined keyword candidates against real buyer queries.
    if (msg.action === 'probeAutosuggest') {
      handleProbeAutosuggest(msg.query, sendResponse);
      return true;
    }
  });

  // Fetch Etsy's suggestion dropdown for a query. Returns the plain suggestion
  // strings (the shop-names HTML row is filtered out by the '<' check).
  async function handleProbeAutosuggest(query, sendResponse) {
    try {
      const r = await fetch('/suggestions_ajax.php?search_query=' + encodeURIComponent(query || ''), { credentials: 'include' });
      if (!r.ok) { sendResponse({ success: false, status: r.status, suggestions: [] }); return; }
      const j = await r.json();
      const suggestions = (j.results || [])
        .map(x => (x && x.query) ? String(x.query) : '')
        .filter(s => s && !s.includes('<'));
      sendResponse({ success: true, suggestions });
    } catch (e) {
      sendResponse({ success: false, error: e.message, suggestions: [] });
    }
  }

  // Parse a review count string like "31.4k", "1,234", "38" into an integer
  // 2026-08-21: returns null when it cannot parse, NOT 0. Every caller assigns to
  // shop_reviews, and 0 means "brand-new shop" — the most beatable value there is —
  // so an unreadable count used to promote a slot to beatable. Same trap that made
  // the audit skip zero-review shops (audit finding 3).
  function parseReviewCount(str) {
    if (!str && str !== 0) return null;
    const cleaned = String(str).replace(/[(),]/g, '').trim();
    if (!cleaned) return null;
    const isK = cleaned.toLowerCase().endsWith('k');
    const n = parseFloat(cleaned);
    if (!Number.isFinite(n)) return null;
    return isK ? Math.round(n * 1000) : Math.round(n);
  }

  function handleExtractSearchResults(sendResponse) {
    try {
      const listings = [];
      const seenIds = new Set();

      // ─── Find listing cards ───
      // 2026-05-01: Scope card extraction to the main search-results container.
      // Etsy renders a "Recently viewed" carousel at the bottom of search
      // pages whose cards share the same `v2-listing-card` class and
      // `data-listing-id` attribute as the main results. A page-wide
      // querySelector therefore picked them up too, and they bled into the
      // captured set at high search_position numbers — producing the
      // cross-niche contamination we saw (same 2 listings appearing under
      // many unrelated keywords).
      //
      // Fix: query inside the canonical results-list container only. As a
      // belt-and-suspenders second pass, drop any card that resolves to be
      // inside a "Recently viewed" subtree even if the scoping somehow misses.
      const resultsRoot = document.querySelector(
        'ol[data-search-results-list]'
      ) || document.querySelector(
        'div[data-search-results-list]'
      ) || document.querySelector(
        'div[data-search-results]'
      ) || null;

      // Identify the "Recently viewed" subtree by its heading and exclude any
      // cards descending from it. We don't rely on a stable data-* attribute
      // because Etsy doesn't currently expose one for this module.
      const RECENTLY_VIEWED_RE = /^\s*recently\s+viewed\s*$/i;
      const recentlyViewedRoots = [];
      document.querySelectorAll('h1, h2, h3, h4').forEach(h => {
        if (RECENTLY_VIEWED_RE.test(h.textContent || '')) {
          const container = h.closest('section, aside, [role="region"]')
            || (h.parentElement && h.parentElement.parentElement)
            || h.parentElement;
          if (container) recentlyViewedRoots.push(container);
        }
      });

      const isInRecentlyViewed = (card) => {
        for (const root of recentlyViewedRoots) {
          if (root.contains(card)) return true;
        }
        return false;
      };

      const queryRoot = resultsRoot || document;
      let cards = queryRoot.querySelectorAll('div.v2-listing-card[data-listing-id]');
      if (cards.length === 0) {
        cards = queryRoot.querySelectorAll('[data-listing-id]');
      }
      const rawCount = cards.length;

      // Deduplicate cards by listing ID — keep the outermost (largest) card per ID
      const cardMap = new Map();
      let droppedRecentlyViewed = 0;
      cards.forEach(card => {
        const id = card.getAttribute('data-listing-id');
        if (!id || !/^\d+$/.test(id)) return;
        if (isInRecentlyViewed(card)) { droppedRecentlyViewed++; return; }
        // Prefer larger cards (outer wrappers) — they contain all the data
        const existing = cardMap.get(id);
        if (!existing || card.contains(existing)) {
          cardMap.set(id, card);
        }
      });

      // Diagnostic: surface scoping outcome so future Etsy markup drift is
      // visible from the popup log without re-instrumenting the page.
      try {
        console.log(
          `[Etsy Search Extractor] resultsRoot=${resultsRoot ? resultsRoot.tagName : 'document'}, raw=${rawCount}, dropped_recently_viewed=${droppedRecentlyViewed}, kept=${cardMap.size}`
        );
      } catch (_) { /* console may be sandboxed */ }

      let position = 0;
      // 2026-08-19 (v2.0.0): count ad cards BEFORE skipping them. Ads were
      // previously excluded pre-count, which left ads_count_top_n permanently
      // empty and the formula blind to paid saturation. Ads are still EXCLUDED
      // from the captured listings (positions stay true organic ranks); only
      // the counts leave this loop.
      let adCount = 0;
      let rawSlots = 0;
      for (const [listingId, card] of cardMap) {
        // ─── Ad filtering ───
        // IMPORTANT: Etsy's DOM includes "Ad from shop X" in wt-screen-reader-only spans
        // for BOTH ad and organic listings (CSS classes toggle visibility).
        // Similarly, innerText may include "Ad・By" for all listings depending on
        // computed styles. These text-based checks are UNRELIABLE and must NOT be used.
        //
        // RELIABLE ad indicators:
        // 1. Ad listings have h3 with id="ad-listing-title-XXXX" (organic: id="listing-title-XXXX")
        // 2. Ad listings may have input[name="listing_source"][value="ads"] in their form

        // Skip duplicates first so a card counts once in the ad stats too
        if (seenIds.has(listingId)) continue;
        seenIds.add(listingId);
        rawSlots++;

        // Strategy 1: Check for hidden input listing_source="ads" inside the card
        const adSourceInput = card.querySelector('input[name="listing_source"][value="ads"]');
        // Strategy 2: Card has ad-listing-title ID prefix on the h3 heading
        const isAdCard = !!adSourceInput || !!card.querySelector('[id^="ad-listing-title-"]');
        if (isAdCard) { adCount++; continue; }

        position++;
        const listing = {
          listing_id: listingId,
          search_position: position
        };

        const cardText = card.innerText || '';
        const cardTextLower = cardText.toLowerCase();

        // ─── URL ───
        const mainLink = card.querySelector('a[href*="/listing/"]');
        listing.etsy_url = mainLink ? mainLink.href.split('?')[0] : '';

        // ─── Thumbnail URL ───
        // Etsy search cards lazy-load images. The actual src may be in
        // `src`, `data-src`, or `srcset` (responsive). Try in priority order.
        listing.thumbnail_url = '';
        const imgEl = card.querySelector('img');
        if (imgEl) {
          // Prefer the resolved src (post-lazy-load)
          let src = imgEl.getAttribute('src') || '';
          if (!src || src.startsWith('data:')) {
            src = imgEl.getAttribute('data-src') || imgEl.getAttribute('data-srcset') || '';
          }
          if (!src) {
            // Pick first URL from srcset if present
            const srcset = imgEl.getAttribute('srcset') || '';
            if (srcset) {
              const firstUrl = srcset.split(',')[0].trim().split(/\s+/)[0];
              if (firstUrl) src = firstUrl;
            }
          }
          // Only accept Etsy CDN URLs to avoid 1x1 trackers / placeholders
          if (src && /i\.etsystatic\.com/.test(src)) {
            listing.thumbnail_url = src.split('?')[0];
          }
        }

        // ─── Title ───
        listing.title = '';
        // Strategy 1: h2/h3 heading (Etsy's standard title location)
        const heading = card.querySelector('h3, h2');
        if (heading) listing.title = heading.textContent.trim();
        // Strategy 2: title attribute on heading or link
        if (!listing.title) {
          const titleAttr = card.querySelector('[title]');
          if (titleAttr) listing.title = titleAttr.getAttribute('title') || '';
        }
        // Strategy 3: aria-label on image link
        if (!listing.title && mainLink) {
          listing.title = mainLink.getAttribute('aria-label') || '';
        }

        // ─── Price extraction ───
        // Etsy 2026 DOM structure:
        //   .n-listing-card__price contains:
        //     <span class='currency-symbol'>USD </span><span class='currency-value'>20.73</span>
        //   For sale items, there's also:
        //     <span class="wt-text-strikethrough ..."><span class='currency-value'>41.47</span></span>
        //     <span class="wt-screen-reader-only">Sale Price USD 20.73</span>
        //     <span class="wt-screen-reader-only">Original Price USD 41.47</span>
        //     (50% off)
        listing.price = 0;
        listing.original_price = null;
        listing.discount_pct = null;

        const priceContainer = card.querySelector('.n-listing-card__price');
        if (priceContainer) {
          // Method A: Parse screen-reader-only text (most reliable for sale items)
          const srTexts = priceContainer.querySelectorAll('.wt-screen-reader-only');
          let salePrice = null, origPrice = null;
          for (const sr of srTexts) {
            const txt = sr.textContent.trim();
            const salePriceMatch = txt.match(/Sale\s+Price\s+(?:USD\s+)?([\d,.]+)/i);
            if (salePriceMatch) salePrice = parseFloat(salePriceMatch[1].replace(/,/g, ''));
            const origPriceMatch = txt.match(/Original\s+Price\s+(?:USD\s+)?([\d,.]+)/i);
            if (origPriceMatch) origPrice = parseFloat(origPriceMatch[1].replace(/,/g, ''));
          }

          if (salePrice && salePrice > 0) {
            listing.price = salePrice;
            if (origPrice && origPrice > salePrice) {
              listing.original_price = origPrice;
              listing.discount_pct = Math.round((1 - salePrice / origPrice) * 100);
            }
          }

          // Method B: If no sale text, get price from currency-value spans
          if (!listing.price) {
            const currencyValues = priceContainer.querySelectorAll('span.currency-value');
            const prices = [];
            for (const cv of currencyValues) {
              const val = parseFloat(cv.textContent.replace(/[^0-9.]/g, ''));
              if (val > 0) prices.push(val);
            }
            const uniquePrices = [...new Set(prices)].sort((a, b) => a - b);
            if (uniquePrices.length >= 2) {
              listing.price = uniquePrices[0];
              listing.original_price = uniquePrices[uniquePrices.length - 1];
              listing.discount_pct = Math.round((1 - listing.price / listing.original_price) * 100);
            } else if (uniquePrices.length === 1) {
              listing.price = uniquePrices[0];
            }
          }

          // Method C: Parse "(X% off)" text for discount
          if (!listing.discount_pct) {
            const offMatch = priceContainer.textContent.match(/\((\d+)\s*%\s*off\)/i);
            if (offMatch) {
              listing.discount_pct = parseInt(offMatch[1]);
              if (!listing.original_price && listing.price && listing.discount_pct > 0) {
                listing.original_price = Math.round(listing.price / (1 - listing.discount_pct / 100) * 100) / 100;
              }
            }
          }
        }

        // Fallback: extract from full card text if price container not found
        if (!listing.price) {
          const usdMatches = cardText.match(/USD\s*([\d,.]+)/g);
          if (usdMatches) {
            for (const m of usdMatches) {
              const val = parseFloat(m.replace(/USD\s*/, '').replace(/,/g, ''));
              if (val > 0) { listing.price = val; break; }
            }
          }
        }

        // ─── Shop rating & shop review count ───
        // These are SHOP-LEVEL metrics from the search card, not listing-specific.
        // Etsy 2026 DOM: div[role="img"][aria-label="4.9 star rating with 31.4k reviews"]
        // Also: <span class="wt-text-title-small">4.9</span> for the rating number
        //        <p class="wt-text-body-smaller">(31.4k)</p> for the review count display
        listing.shop_rating = null;
        // 2026-08-21: null, not 0. A card with no rating element means "we did
        // not see a review count", which is not the same as "this shop has zero
        // reviews" — and 0 reads as the most beatable shop possible, so the old
        // default quietly promoted every unreadable card to a beatable slot.
        listing.shop_reviews = null;

        // Strategy 1 (PRIMARY): aria-label on role="img" element
        const ratingImgEl = card.querySelector('[role="img"][aria-label*="star rating"]');
        if (ratingImgEl) {
          const label = ratingImgEl.getAttribute('aria-label') || '';
          const combined = label.match(/([0-9]+(?:\.[0-9]+)?)\s*star\s*rating\s*with\s*([0-9,.]+[kK]?)\s*reviews?/i);
          if (combined) {
            listing.shop_rating = parseFloat(combined[1]);
            listing.shop_reviews = parseReviewCount(combined[2]);
          }
        }

        // Strategy 1b: Etsy's newer card markup puts the rating in a web component
        // whose real content lives in a shadow root — <clg-static-review-stars
        // rating="4.7" review-count-text="(1.9k)"> — so the aria-label above is not
        // present at all. Observed 2026-08-21 in a Scrappey capture (52 of 64 cards)
        // while this browser was still being served the aria-label variant, i.e.
        // Etsy is running both. The attributes are on the host element, so no shadow
        // piercing is needed. Without this, the newer variant yields NO shop review
        // counts, which would take beatable slots to zero on every keyword and fail
        // every niche at the qualification gate.
        if (listing.shop_reviews === null) {
          const starsEl = card.querySelector('clg-static-review-stars[review-count-text]');
          if (starsEl) {
            const r = parseFloat(starsEl.getAttribute('rating'));
            if (Number.isFinite(r) && r > 0 && r <= 5) listing.shop_rating = r;
            listing.shop_reviews = parseReviewCount(starsEl.getAttribute('review-count-text'));
          }
        }

        // Strategy 2: If aria-label not found, try the visible text elements
        if (!listing.shop_rating) {
          // Rating from span.wt-text-title-small inside the rating area
          const ratingArea = card.querySelector('.shop-name-with-rating, .streamline-spacing-shop-rating');
          if (ratingArea) {
            const ratingSpan = ratingArea.querySelector('span.wt-text-title-small');
            if (ratingSpan) {
              const val = parseFloat(ratingSpan.textContent.trim());
              if (val > 0 && val <= 5) listing.shop_rating = val;
            }
            // Review count from "(Xk)" or "(X,XXX)" pattern
            const reviewP = ratingArea.querySelector('p.wt-text-body-smaller');
            if (reviewP) {
              const inner = reviewP.textContent.replace(/[()]/g, '').trim();
              listing.shop_reviews = parseReviewCount(inner);
            }
          }
        }

        // Strategy 3: General aria-label scan as last resort
        if (!listing.shop_rating) {
          const allAriaEls = card.querySelectorAll('[aria-label]');
          for (const el of allAriaEls) {
            const label = el.getAttribute('aria-label') || '';
            const combined = label.match(/([0-9]+(?:\.[0-9]+)?)\s*star\s*rating\s*with\s*([0-9,.]+[kK]?)\s*reviews?/i);
            if (combined) {
              listing.shop_rating = parseFloat(combined[1]);
              listing.shop_reviews = parseReviewCount(combined[2]);
              break;
            }
          }
        }

        // ─── Shop name ───
        listing.shop_name = '';

        // Strategy 1 (PRIMARY): data-seller-name-link or clickable-shop-name
        // Etsy 2026 DOM: <span class='wt-text-link clickable-shop-name' data-seller-name-link>ShopName</span>
        const sellerNameEl = card.querySelector('[data-seller-name-link], .clickable-shop-name');
        if (sellerNameEl) {
          listing.shop_name = sellerNameEl.textContent.trim();
        }

        // Strategy 2: Screen-reader "From shop X" text
        if (!listing.shop_name) {
          const srShopSpans = card.querySelectorAll('.wt-screen-reader-only');
          for (const sr of srShopSpans) {
            const txt = sr.textContent.trim();
            // Match "From shop X" but NOT "Ad from shop X"
            const fromMatch = txt.match(/^From\s+shop\s+(\S+)/i);
            if (fromMatch) {
              listing.shop_name = fromMatch[1].trim();
              break;
            }
          }
        }

        // Strategy 3: data-shop-url attribute on clickable shop name
        if (!listing.shop_name) {
          const shopUrlEl = card.querySelector('[data-shop-url]');
          if (shopUrlEl) {
            const shopUrl = shopUrlEl.getAttribute('data-shop-url') || '';
            const shopMatch = shopUrl.match(/\/shop\/([^/?]+)/);
            if (shopMatch) listing.shop_name = shopMatch[1];
          }
        }

        // Strategy 4: shop link in tooltip
        if (!listing.shop_name) {
          const tooltipShop = card.querySelector('.listing-card-tooltip strong');
          if (tooltipShop) {
            const name = tooltipShop.textContent.trim();
            if (name.length > 1 && name.length < 50) listing.shop_name = name;
          }
        }

        // Clean up shop name
        listing.shop_name = listing.shop_name
          .replace(/^Ad\s*[·•\-|]\s*By\s*/i, '')
          .replace(/^From\s+shop\s*/i, '')
          .replace(/^By\s+/i, '')
          .trim();

        // ─── Badges ───
        listing.is_digital = cardTextLower.includes('digital download');
        listing.is_bestseller = false;
        listing.is_popular_now = false;

        // Check clg-signal elements (Etsy's custom badge components)
        // These are web components with Shadow DOM — textContent alone won't work,
        // we need to also check shadowRoot for the actual rendered text.
        const signalEls = card.querySelectorAll('clg-signal');
        for (const sig of signalEls) {
          let sigText = sig.textContent.trim().toLowerCase();
          // Penetrate Shadow DOM if textContent is empty
          if (!sigText && sig.shadowRoot) {
            sigText = (sig.shadowRoot.textContent || '').trim().toLowerCase();
          }
          if (sigText.includes('bestseller') || sigText.includes('best seller')) listing.is_bestseller = true;
          if (sigText.includes('popular now')) listing.is_popular_now = true;
        }
        // Also check text in case clg-signal content isn't accessible
        if (!listing.is_bestseller && (cardTextLower.includes('bestseller') || cardTextLower.includes('best seller'))) {
          listing.is_bestseller = true;
        }
        if (!listing.is_popular_now && cardTextLower.includes('popular now')) {
          listing.is_popular_now = true;
        }

        // ─── Urgency signals ───
        // Etsy shows urgency on search cards via:
        //   1. Text in the card body ("Only 3 left", "In 20+ people's carts", etc.)
        //   2. Custom <clg-signal> web components (badges like "Bestseller", "Popular now")
        //   3. Spans/divs with aria-labels or data attributes for demand signals
        //   4. Screen-reader-only spans with demand text
        // NOTE: "In demand. X people bought this in the last 24 hours" is on DETAIL pages only.
        //       On search cards, Etsy typically shows "In X people's carts" or "Only X left".
        listing.urgency_text = '';

        // Collect all text from the card including custom elements and aria-labels
        let allCardText = cardText;

        // Also grab text from clg-signal elements and other signal components.
        // These may use Shadow DOM, so check shadowRoot when textContent is empty.
        const signals = card.querySelectorAll('clg-signal, [data-signal], [data-urgency]');
        for (const sig of signals) {
          let sigText = sig.textContent || '';
          // Penetrate Shadow DOM
          if (!sigText.trim() && sig.shadowRoot) {
            sigText = sig.shadowRoot.textContent || '';
          }
          sigText = sigText || sig.getAttribute('aria-label') || '';
          if (sigText) allCardText += ' ' + sigText;
        }

        // Also check all shadow roots in the card for any hidden urgency text
        const allCustomEls = card.querySelectorAll('*');
        for (const el of allCustomEls) {
          if (el.shadowRoot) {
            const shadowText = el.shadowRoot.textContent || '';
            if (/cart|demand|sold|left|stock|selling|gone|bestseller|popular/i.test(shadowText)) {
              allCardText += ' ' + shadowText;
            }
          }
        }

        // Check aria-labels on all elements (Etsy sometimes puts urgency in aria-label)
        const ariaEls = card.querySelectorAll('[aria-label]');
        for (const el of ariaEls) {
          const label = el.getAttribute('aria-label') || '';
          if (/cart|demand|sold|left|stock|selling|gone/i.test(label)) {
            allCardText += ' ' + label;
          }
        }

        // Check screen-reader-only spans for urgency text
        const srSpans = card.querySelectorAll('.wt-screen-reader-only, [class*="screen-reader"]');
        for (const sr of srSpans) {
          const txt = sr.textContent || '';
          if (/cart|demand|sold|left|stock|selling|gone/i.test(txt)) {
            allCardText += ' ' + txt;
          }
        }

        const urgencyPatterns = [
          /in\s+demand/i,
          /\d+\s+people?\s+bought\s+this/i,
          /in\s+(\d+\+?)\s+people[''\u2019]?s?\s+carts?/i,
          /in\s+(\d+\+?)\s+carts?/i,
          /only\s+(\d+)\s+left/i,
          /sold\s+(\d+)/i,
          /almost\s+gone/i,
          /selling\s+fast/i,
          /low\s+in\s+stock/i,
          /popular\s+now/i,
          /trending\s+now/i,
          /last\s+one/i
        ];
        const urgencyParts = [];
        const seenPatterns = new Set();
        for (const pattern of urgencyPatterns) {
          const match = allCardText.match(pattern);
          if (match) {
            const found = match[0].trim();
            // Deduplicate (same signal might appear in multiple text sources)
            const key = found.toLowerCase();
            if (!seenPatterns.has(key)) {
              seenPatterns.add(key);
              urgencyParts.push(found);
            }
          }
        }
        listing.urgency_text = urgencyParts.join('; ');

        // ─── Free delivery signal ───
        listing.free_delivery = cardTextLower.includes('free delivery') || cardTextLower.includes('free shipping');

        listings.push(listing);
      }

      // Extract total search results count from JSON-LD ItemList
      let totalResultsCount = null;
      try {
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of ldScripts) {
          try {
            const ld = JSON.parse(script.textContent);
            if (ld['@type'] === 'ItemList' && ld.numberOfItems != null) {
              totalResultsCount = parseInt(ld.numberOfItems) || null;
              break;
            }
          } catch(e) {}
        }
      } catch(e) {}

      sendResponse({ success: true, listings, totalFound: listings.length, totalResultsCount,
        // page-level ad stats: distinct ad cards + total distinct slots seen
        adCount, rawSlots });
    } catch (err) {
      sendResponse({ success: false, error: err.message, listings: [] });
    }
  }
})();
