// Etsy Listing Detail Extractor — Content Script
// Runs on: https://www.etsy.com/listing/*

(function() {
  'use strict';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'extractEtsyListingDetail') {
      handleExtractDetail(sendResponse);
      return true;
    }
  });

  function handleExtractDetail(sendResponse) {
    try {
      const data = {};
      const pageText = document.body.innerText;
      // 2026-08-08: header-free text for urgency/cart parsing.
      // document.body.innerText includes Etsy's site header, which renders
      // "Sign in 0 Cart …" (and "N Cart" when the SHOPPER has items in their own
      // basket). Since .match() returns the FIRST hit, that header could hijack
      // the in-carts number and record the shopper's own cart count instead of
      // the listing's. Verified on live listing pages: <header> sits BEFORE
      // <main>, and the urgency badge sits INSIDE <main> — so scoping to <main>
      // drops the header while keeping every signal we read. Falls back to body
      // if Etsy ever drops <main>, so this can never extract less than before.
      const mainText = (document.querySelector('main') || document.body).innerText;

      // ─── Listing-level rating ───
      // Etsy listing pages show rating as stars + number, e.g. "4.9 out of 5 stars"
      // or in structured data (JSON-LD)
      let rating = null, reviewCount = null;

      // Method 1: JSON-LD structured data (most reliable)
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of ldScripts) {
        try {
          const ld = JSON.parse(script.textContent);
          const product = ld['@type'] === 'Product' ? ld : (ld['@graph'] || []).find(g => g['@type'] === 'Product');
          if (product && product.aggregateRating) {
            rating = parseFloat(product.aggregateRating.ratingValue);
            // 2026-08-21: only attribute this count to the LISTING when the block
            // also carries the listing's own reviews. Verified live on listing
            // 4553012151: a listing with no reviews of its own still gets an
            // aggregateRating — but it is the SHOP's (262, identical to the shop
            // element, with an empty review array and no reviews section on the
            // page). Storing that as the listing's review count made a listing
            // with zero reviews look like one with 262.
            const ownReviews = Array.isArray(product.review) ? product.review.length : 0;
            if (ownReviews > 0) {
              reviewCount = parseInt(product.aggregateRating.reviewCount || product.aggregateRating.ratingCount);
            }
          }
        } catch(e) {}
      }

      // Method 2: Meta tags
      if (!rating) {
        const ratingMeta = document.querySelector('meta[itemprop="ratingValue"], meta[property="og:rating"]');
        if (ratingMeta) rating = parseFloat(ratingMeta.getAttribute('content'));
        const countMeta = document.querySelector('meta[itemprop="reviewCount"], meta[itemprop="ratingCount"]');
        if (countMeta) reviewCount = parseInt(countMeta.getAttribute('content'));
      }

      // Method 3: DOM elements — look for star rating display
      if (!rating) {
        const ratingEls = document.querySelectorAll('[data-rating], [class*="stars-svg"] [class*="screen-reader"], [aria-label*="star"], [class*="review"] [class*="rating"]');
        for (const el of ratingEls) {
          const ariaLabel = el.getAttribute('aria-label') || '';
          const dataRating = el.getAttribute('data-rating');
          if (dataRating) { rating = parseFloat(dataRating); break; }
          const starMatch = ariaLabel.match(/([\d.]+)\s*(?:out\s*of\s*5\s*)?star/i);
          if (starMatch) { rating = parseFloat(starMatch[1]); break; }
        }
      }

      // Method 4: Text pattern — "X out of 5 stars" or "(X,XXX)"
      if (!rating) {
        const ratingTextMatch = pageText.match(/([\d.]+)\s*out\s*of\s*5\s*stars?/i);
        if (ratingTextMatch) rating = parseFloat(ratingTextMatch[1]);
      }
      // 2026-08-21: the page-wide "N reviews" fallback is gone. On a listing with
      // no reviews of its own the only such number on the page is the SHOP's, so
      // this fallback was the main way a shop's count got stored as a listing's.
      // A null review count is honest; a wrong one is not, and nothing in scoring
      // reads this field — only the stored row and the dashboard display.

      data.listing_rating = (rating && !isNaN(rating) && rating > 0) ? rating : null;
      data.listing_review_count = (reviewCount && !isNaN(reviewCount) && reviewCount > 0) ? reviewCount : null;

      // ─── Urgency signal (full text) ───
      // Etsy renders urgency inside a specific component near the price.
      // Real examples from live pages:
      //   "In demand. 4 people bought this in the last 24 hours."
      //   "20+ views in the last 24 hours"
      //   "Only 3 left and in 4 baskets"
      //   "In 10 baskets"
      //   "8 views in the last 24 hours"
      //   "Selling fast! 12 people have this in their carts."

      data.urgency_text = '';

      // Method 1: DOM — find the UrgencySignal component (most reliable)
      const urgencySelectors = [
        '[data-appears-component-name*="UrgencySignal"]',
        '[data-appears-component-name*="urgency"]',
        '[data-appears-component-name*="Urgency"]',
      ];
      for (const sel of urgencySelectors) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            const text = el.textContent.trim();
            if (text.length > 2 && text.length < 200) {
              data.urgency_text = text;
              break;
            }
          }
        } catch(e) {}
      }

      // Method 2: Look for wt-sem-text-critical paragraphs near price (Etsy's urgency styling)
      if (!data.urgency_text) {
        const criticalEls = document.querySelectorAll('p.wt-sem-text-critical, div.wt-sem-text-critical, span.wt-sem-text-critical');
        for (const el of criticalEls) {
          const text = el.textContent.trim();
          // Filter to actual urgency signals (not prices or other critical text)
          if (text.length > 5 && text.length < 200 &&
              /basket|cart|bought|sold|view|demand|left|selling|hurry|popular|trending/i.test(text)) {
            data.urgency_text = text;
            break;
          }
        }
      }

      // Method 3: Text patterns on full page (fallback)
      if (!data.urgency_text) {
        const urgencyPatterns = [
          /In\s+demand\.?\s+\d+\s+people\s+bought\s+this[^.]*\./i,
          /Selling\s+fast[!.]?\s*\d+\s+people[^.]*\./i,
          /Only\s+\d+\s+left\s+and\s+in\s+\d+\+?\s*(?:basket|cart)s?/i,
          /Only\s+\d+\s+left/i,
          // \+? — Etsy caps the badge at "In 20+ carts" / "In 17+ baskets"; the
          // old \d+-only pattern rejected every capped listing (the hottest ones).
          /In\s+\d+\+?\s*(?:basket|cart)s?/i,
          /\d+\+?\s+views?\s+in\s+the\s+last\s+24\s+hours?/i,
          /\d+\s+people?\s+bought\s+this\s+in\s+the\s+last\s+24\s+hours?/i,
          /Sold\s+\d+\s+times?\s+in\s+the\s+last\s+24\s+hours?/i,
        ];
        for (const pat of urgencyPatterns) {
          // mainText, not pageText — the "In N carts" pattern below would
          // otherwise match the header's "Sign in 0 Cart" (see mainText note).
          const m = mainText.match(pat);
          if (m) { data.urgency_text = m[0].trim(); break; }
        }
      }

      // ─── Social proof numbers (parsed from urgency text or page text) ───
      // In X carts/baskets
      // 2026-08-08 two fixes here:
      //  1. \+?\s* — Etsy now caps the badge ("In 20+ carts", "In 17+ baskets").
      //     The old \d+\s+ pattern failed on those outright (the "+" broke it),
      //     so every capped listing — i.e. the highest-demand ones — recorded
      //     null. We store the floor (20+ -> 20), which is what the badge means.
      //  2. Read the SCOPED urgency element first, then mainText (header-free),
      //     never raw pageText: the site header's "Sign in 0 Cart" / the
      //     shopper's own basket count would otherwise win as the first match.
      // (?<!Sign\s) — second line of defence. mainText already drops the header
      // on today's layout, but if Etsy ever removes <main> we fall back to body,
      // and the header's "Sign in 0 Cart" (or "Sign in 3 Cart" when the SHOPPER
      // has their own items) would otherwise be recorded as this listing's
      // in-carts. Chrome supports lookbehind, so this is safe in an MV3 script.
      // ['’] — Etsy renders a typographic apostrophe (U+2019) in "people’s carts"
      // on many locales; the straight-quote-only pattern silently missed those.
      const CART_RE = /(?<!Sign\s)In\s+(\d+)\+?\s*(?:people(?:['’]s)?\s+)?(?:cart|basket)s?/i;
      const cartMatch = (data.urgency_text && data.urgency_text.match(CART_RE))
        || mainText.match(CART_RE);
      data.in_carts = cartMatch ? parseInt(cartMatch[1]) : null;

      // X people bought this in last 24 hours
      const boughtMatch = pageText.match(/(\d+)\s+people\s+bought\s+this\s+in\s+the\s+last\s+24\s+hours?/i);
      // Sold X times in last 24 hours
      const soldMatch = pageText.match(/Sold\s+(\d+)\s+times?\s+in\s+the\s+last\s+24\s+hours?/i);
      data.sold_24h = boughtMatch ? parseInt(boughtMatch[1]) : (soldMatch ? parseInt(soldMatch[1]) : null);

      // X views in last 24 hours
      const viewsMatch = pageText.match(/(\d+)\+?\s+views?\s+in\s+the\s+last\s+24\s+hours?/i);
      data.views_24h = viewsMatch ? parseInt(viewsMatch[1]) : null;

      // Thumbnail URL (og:image meta tag)
      const ogImage = document.querySelector('meta[property="og:image"]');
      data.etsy_thumbnail_url = ogImage ? ogImage.getAttribute('content') : '';

      // Also try to get the main listing image
      if (!data.etsy_thumbnail_url) {
        const mainImg = document.querySelector('[class*="listing-image"] img, [data-listing-image] img, .image-carousel img');
        data.etsy_thumbnail_url = mainImg ? mainImg.src : '';
      }

      // ─── Favorites / Hearts count ───
      // Source 1: meta description — "has X favourites/favorites from Etsy shoppers"
      data.favorites_count = null;
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) {
        const descContent = metaDesc.getAttribute('content') || '';
        const favMetaMatch = descContent.match(/has\s+([\d,]+)\s+favou?rites?\s+from/i);
        if (favMetaMatch) data.favorites_count = parseInt(favMetaMatch[1].replace(/,/g, ''));
      }
      // Source 2: og:description (same pattern)
      if (!data.favorites_count) {
        const ogDesc = document.querySelector('meta[property="og:description"]');
        if (ogDesc) {
          const ogContent = ogDesc.getAttribute('content') || '';
          const favOgMatch = ogContent.match(/has\s+([\d,]+)\s+favou?rites?\s+from/i);
          if (favOgMatch) data.favorites_count = parseInt(favOgMatch[1].replace(/,/g, ''));
        }
      }
      // Source 3: visible text — "X favourites" link near bottom
      if (!data.favorites_count) {
        const favMatch = pageText.match(/([\d,]+)\s+favou?rites?/i);
        if (favMatch) data.favorites_count = parseInt(favMatch[1].replace(/,/g, ''));
      }

      // ─── Listing renewal date ("Listed on", v2.0.0, 2026-08-20) ───
      // Etsy renews a listing when it sells (auto-renew) and the seller can renew
      // manually, so a recent "Listed on" date is decent evidence of a recent
      // sale — and it is present even when Etsy shows a basket/view badge
      // instead of a sold count.
      // The 2026-08-19 note that this field was unavailable outside the US was
      // WRONG: it is in the meta description on every locale. What differs is
      // the FORMAT — "Aug 5, 2026" (US) vs "20 Aug, 2026" (UK/PK) — and the old
      // check only looked at the visible body element, which the regional
      // layout does omit. Verified live from a Pakistan browser 2026-08-20:
      // meta + og description both carry it, visible element absent.
      data.listed_on = null;
      try {
        const metaEl = document.querySelector('meta[name="description"]')
          || document.querySelector('meta[property="og:description"]');
        const src = (metaEl && metaEl.content) || pageText;
        // "Listed on 20 Aug, 2026" | "Listed on Aug 5, 2026" | "Listed on 5 August 2026"
        const m = src.match(/Listed on\s+(\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i);
        if (m) {
          const parsed = new Date(m[1].replace(',', ''));
          if (!isNaN(parsed.getTime())) {
            // Format from LOCAL parts, not toISOString(): the string parses as
            // local midnight, and converting that to UTC moves the date back a
            // day east of Greenwich — "20 Aug, 2026" came out as 2026-08-19 in a
            // UTC+5 browser, ageing every listing by one day.
            const yy = parsed.getFullYear();
            const mm = String(parsed.getMonth() + 1).padStart(2, '0');
            const dd = String(parsed.getDate()).padStart(2, '0');
            data.listed_on = `${yy}-${mm}-${dd}`;
          }
        }
      } catch (e) { /* non-fatal — renewal date is a supporting signal */ }

      // ─── Recent review dates (NES freshness leg, v2.0.0) ───
      // Etsy server-renders the last ~4 reviews with dates in the JSON-LD
      // Product block ("review":[{"datePublished":"YYYY-MM-DD",...}]). Verified
      // present on 40/40 live pages (2026-08-19) and locale-proof — unlike the
      // visible "Listed on" date, which some regional layouts omit entirely.
      // last_review_date drives the freshness scoring (≤7d hot / >30-45d cold);
      // recent_review_dates keeps the raw list for future velocity analysis.
      data.last_review_date = null;
      data.recent_review_dates = '';
      // 2026-08-21 (audit #15): report whether Etsy's structured-data block was
      // on the page at all. Verified live on 2026-08-21 that the block — and the
      // review dates in it — arrive in the SERVER HTML of every listing page, so
      // its absence means we were served a partial page, not that the listing has
      // no reviews. Without this flag the two were indistinguishable and Step 3
      // wrote an audit row with a null date, which scoring then had to treat as
      // unknown. 39% of the school run's audits landed in that state.
      data.ld_product_found = false;
      try {
        const pageHtml = document.documentElement.outerHTML;
        data.ld_product_found = /"@type"\s*:\s*"Product"/.test(pageHtml)
          || /"aggregateRating"/.test(pageHtml);
        const revDates = [...pageHtml.matchAll(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/g)]
          .map(m => m[1]).sort();
        if (revDates.length > 0) {
          data.last_review_date = revDates[revDates.length - 1];
          data.recent_review_dates = revDates.slice(-4).join(',');
        }
      } catch (e) { /* leave the flag false — Step 3 retries rather than guessing */ }

      // ─── Photo count ───
      // Count carousel panes with data-image-id (excludes video panes)
      const imageIds = document.querySelectorAll('[data-carousel-pane][data-image-id]');
      data.photo_count = imageIds.length;
      // Fallback: JSON-LD Product image array
      if (data.photo_count === 0) {
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const ld = JSON.parse(script.textContent);
            const product = ld['@type'] === 'Product' ? ld : null;
            if (product && Array.isArray(product.image)) {
              data.photo_count = product.image.length;
              break;
            }
          } catch(e) {}
        }
      }

      // ─── Has video ───
      data.has_video = !!document.querySelector('video[id^="listing-video"], [data-video-pane]');
      // Fallback: JSON-LD VideoObject
      if (!data.has_video) {
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const ld = JSON.parse(script.textContent);
            if (ld['@type'] === 'VideoObject') { data.has_video = true; break; }
          } catch(e) {}
        }
      }

      // ─── Related search queries (Etsy's own suggestions) ───
      data.related_search_queries = [];
      try {
        const tagsContainer = document.querySelector('[data-appears-component-name="Listzilla_ApiSpecs_Tags_MultiChannelLanding"]');
        if (tagsContainer) {
          const eventData = tagsContainer.getAttribute('data-appears-event-data');
          if (eventData) {
            const parsed = JSON.parse(eventData);
            if (Array.isArray(parsed.queries)) {
              data.related_search_queries = parsed.queries;
            }
          }
        }
      } catch(e) {}
      // Fallback: scrape the visual tag cards text
      if (data.related_search_queries.length === 0) {
        const tagCards = document.querySelectorAll('.tag-cards-section-container-with-images .wt-card');
        for (const card of tagCards) {
          const link = card.querySelector('a[href*="/market/"]');
          if (link) {
            const text = link.textContent.trim();
            if (text && text.length > 1 && text.length < 100) {
              data.related_search_queries.push(text);
            }
          }
        }
      }

      // ─── Shop data from listing detail page ───
      // 2026-04-19: extractor rewritten to match Etsy's current "Meet your seller"
      // section DOM. Verified against live listing HTML. Captures rating + review
      // count + sales (with k/m suffix) + tenure (computed → year) + star seller +
      // team size + location.
      data.shop_total_sales = null;
      data.shop_location = null;
      data.shop_established = null;
      data.is_star_seller = false;
      data.shop_team_size = null;
      data.shop_rating = null;
      data.shop_review_count = null;

      // Helper: parse "26.3k" / "9.7k" / "1.2m" / "1,234" → integer
      const parseHumanNumber = (s) => {
        if (!s) return null;
        const cleaned = String(s).trim().replace(/[(),]/g, '').toLowerCase();
        const m = cleaned.match(/^([\d.]+)\s*([km]?)$/);
        if (!m) return null;
        let n = parseFloat(m[1]);
        if (isNaN(n)) return null;
        if (m[2] === 'k') n *= 1000;
        else if (m[2] === 'm') n *= 1000000;
        return Math.round(n);
      };

      // ─── Shop rating + review count (seller cred area) ───
      // DOM: <span class="rating-and-reviews-count__avg-rating">5.0</span>
      //      <span class="rating-and-reviews-count__reviews-count">(9.7k)</span>
      try {
        const ratingEl = document.querySelector('.rating-and-reviews-count__avg-rating');
        if (ratingEl) {
          const r = parseFloat(ratingEl.textContent.trim());
          if (!isNaN(r) && r > 0) data.shop_rating = r;
        }
        const reviewsEl = document.querySelector('.rating-and-reviews-count__reviews-count');
        if (reviewsEl) {
          const n = parseHumanNumber(reviewsEl.textContent);
          if (n != null && n > 0) data.shop_review_count = n;
        }
      } catch(e) {}

      // ─── Shop total sales ───
      // DOM has e.g. "26.3k sales" inside .wt-text-title in seller cred row.
      // Old regex `([\d,]+)\s+sales` missed "26.3k sales" — handle k/m suffix.
      const salesMatch = pageText.match(/([\d,.]+)\s*([kKmM]?)\s+sales\b/);
      if (salesMatch) {
        const salesNum = parseHumanNumber(salesMatch[1] + salesMatch[2]);
        if (salesNum && salesNum > 0) data.shop_total_sales = salesNum;
      }

      // ─── Shop location ───
      // Meta description: "Dispatched from United States" or "Ships from ..."
      // Also seller cred has "<p>Atlanta, Georgia</p>" near shop name.
      if (metaDesc) {
        const descContent = metaDesc.getAttribute('content') || '';
        const locMatch = descContent.match(/(?:Dispatched|Ships?)\s+from\s+([^.,"]+)/i);
        if (locMatch) data.shop_location = locMatch[1].trim();
      }
      // Fallback: JSON-LD shipping origin
      if (!data.shop_location) {
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const ld = JSON.parse(script.textContent);
            const product = ld['@type'] === 'Product' ? ld : null;
            if (product && product.offers && product.offers.shippingDetails) {
              const origin = product.offers.shippingDetails.shippingOrigin;
              if (origin && origin.addressCountry) {
                data.shop_location = origin.addressCountry;
              }
            }
          } catch(e) {}
        }
      }

      // ─── Shop established / tenure → derived year ───
      // 2026-04-19: Etsy moved away from "On Etsy since YYYY". Now shows
      // "X years on Etsy" via component data-appears-component-name="lp_seller_cred_tenure"
      // with data-appears-event-data='{"tenure":"4 years"}'. Compute year as
      // currentYear - tenureYears so we keep storing a year string for display.
      try {
        const tenureEl = document.querySelector('[data-appears-component-name="lp_seller_cred_tenure"]');
        if (tenureEl) {
          const eventData = tenureEl.getAttribute('data-appears-event-data');
          if (eventData) {
            const parsed = JSON.parse(eventData);
            const tenureStr = String(parsed.tenure || '');
            const yearMatch = tenureStr.match(/(\d+)\s*year/i);
            const monthMatch = tenureStr.match(/(\d+)\s*month/i);
            const currentYear = new Date().getFullYear();
            if (yearMatch) {
              data.shop_established = String(currentYear - parseInt(yearMatch[1]));
            } else if (monthMatch) {
              data.shop_established = String(currentYear);
            }
          }
        }
      } catch(e) {}
      // Fallback 1: visible text "X years on Etsy"
      if (!data.shop_established) {
        const m = pageText.match(/(\d+)\s+years?\s+on\s+Etsy\b/i);
        if (m) {
          data.shop_established = String(new Date().getFullYear() - parseInt(m[1]));
        }
      }
      // Fallback 2: legacy "On Etsy since YYYY" (older shops may still show this)
      if (!data.shop_established) {
        const sinceMatch = pageText.match(/On\s+Etsy\s+since\s+(\d{4})/i);
        if (sinceMatch) data.shop_established = sinceMatch[1];
      }

      // ─── Star Seller badge ───
      data.is_star_seller = !!document.querySelector('[data-appears-component-name*="star_seller"], [class*="star-seller"], [aria-label*="Star Seller"], clg-icon[name="starseller"]');
      if (!data.is_star_seller) {
        data.is_star_seller = /Star\s+Seller/i.test(pageText);
      }

      // ─── Shop team size ───
      try {
        const membersEl = document.querySelector('[data-appears-component-name="lp_seller_cred_shop_members"]');
        if (membersEl) {
          const eventData = membersEl.getAttribute('data-appears-event-data');
          if (eventData) {
            const parsed = JSON.parse(eventData);
            if (parsed.total_members) data.shop_team_size = parsed.total_members;
          }
        }
      } catch(e) {}

      // ─── Listing tags ───
      data.tags_list = '';
      try {
        const tagLinks = [];
        const tagSections = document.querySelectorAll('[id*="tag"], [class*="tag-section"], [data-appears-component-name*="tag"]');
        for (const section of tagSections) {
          const links = section.querySelectorAll('a[href*="/search?q="], a[href*="/market/"]');
          for (const link of links) {
            const text = link.textContent.trim();
            if (text && text.length > 1 && text.length < 100) tagLinks.push(text);
          }
        }
        if (tagLinks.length === 0) {
          const allTagLinks = document.querySelectorAll('ul.wt-action-group a[href*="/search?q="]');
          for (const link of allTagLinks) {
            const text = link.textContent.trim();
            if (text && text.length > 1 && text.length < 80) tagLinks.push(text);
          }
        }
        if (tagLinks.length > 0) data.tags_list = tagLinks.join(', ');
      } catch(e) {}

      // ─── Category breadcrumb ───
      data.category_breadcrumb = '';
      try {
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const ld = JSON.parse(script.textContent);
            if (ld['@type'] === 'BreadcrumbList' && Array.isArray(ld.itemListElement)) {
              const crumbs = ld.itemListElement
                .sort((a, b) => (a.position || 0) - (b.position || 0))
                .map(item => (item.item && item.item.name) || item.name || '')
                .filter(n => n);
              if (crumbs.length > 0) {
                data.category_breadcrumb = crumbs.join(' > ');
                break;
              }
            }
          } catch(e) {}
        }
        if (!data.category_breadcrumb) {
          const breadcrumbNav = document.querySelector('nav[aria-label*="Breadcrumb"], nav[aria-label*="breadcrumb"], [class*="breadcrumb"]');
          if (breadcrumbNav) {
            const items = breadcrumbNav.querySelectorAll('a');
            const crumbs = [];
            for (const item of items) {
              const text = item.textContent.trim();
              if (text && text.length < 100) crumbs.push(text);
            }
            if (crumbs.length > 0) data.category_breadcrumb = crumbs.join(' > ');
          }
        }
      } catch(e) {}

      sendResponse({ success: true, data });
    } catch (err) {
      sendResponse({ success: false, error: err.message, data: {} });
    }
  }
})();
