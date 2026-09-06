// eRank Listing Audit Extractor — Content Script
// Runs on: https://members.erank.com/listing-audit/*

(function() {
  'use strict';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'extractListingAudit') {
      handleExtractAudit(sendResponse);
      return true;
    }
  });

  function handleExtractAudit(sendResponse) {
    try {
      const pageText = document.body.innerText;
      const data = {};

      // Extract Listing Score (most important)
      // Strategy: DOM-first approach — the score is usually in a gauge/circle widget
      // that may not appear cleanly in innerText. Check multiple DOM patterns first.

      // 1. Look for the eRank score gauge — typically a large number inside a circular SVG or canvas
      const gaugeSelectors = [
        '.listing-score-value', '.score-value', '.gauge-value',
        '.score-circle .value', '.listing-audit-score',
        '[class*="gauge"] [class*="value"]',
        '[class*="score-num"]', '[class*="scoreNum"]',
        '.overall-score', '[class*="overall"] [class*="score"]',
        '[class*="listing-score"]',
        // eRank often uses Bootstrap-style or custom progress circles
        '.progress-circle .value', '.circular-chart .value',
        '[class*="CircularProgress"] [class*="label"]',
        '[class*="donut"] [class*="value"]',
      ];
      for (const sel of gaugeSelectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const text = el.textContent.trim().replace(/[^0-9]/g, '');
            const num = parseInt(text);
            if (num > 0 && num <= 100) { data.erank_score = num; break; }
          }
          if (data.erank_score) break;
        } catch(e) {}
      }

      // 2. Look for any element whose text is JUST a number 0-100 near a "Score" heading
      if (!data.erank_score) {
        const allEls = document.querySelectorAll('h1, h2, h3, h4, h5, .display-1, .display-2, .display-3, .display-4, [class*="score"], [class*="Score"], [class*="grade"], [class*="Grade"], [class*="rating"], span, div, p, strong, b');
        for (const el of allEls) {
          // Only check elements whose own text (excluding children) looks like a bare number
          const directText = Array.from(el.childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => n.textContent.trim())
            .join('');
          const num = parseInt(directText.replace(/[^0-9]/g, ''));
          if (num >= 5 && num <= 100 && directText.replace(/[^0-9]/g, '').length <= 3) {
            // Check if this element or a nearby sibling/parent mentions "score"
            const context = (el.className || '') + ' ' + (el.parentElement?.className || '') + ' '
              + (el.parentElement?.textContent?.substring(0, 200) || '');
            if (/score|grade|listing.?audit/i.test(context)) {
              data.erank_score = num;
              break;
            }
          }
        }
      }

      // 3. Text-based patterns (more specific first — avoid greedy "X/100" that hits tag counts)
      if (!data.erank_score) {
        const specificPatterns = [
          /Listing\s*(?:Audit\s*)?Score[:\s]*(\d{1,3})\b/i,
          /Overall\s*Score[:\s]*(\d{1,3})\b/i,
          /Score[:\s]*(\d{1,3})\s*(?:out\s*of\s*)?\/?\s*100/i,
        ];
        for (const pat of specificPatterns) {
          const m = pageText.match(pat);
          if (m) {
            const num = parseInt(m[1]);
            if (num > 0 && num <= 100) { data.erank_score = num; break; }
          }
        }
      }

      // 4. Last resort: find "X/100" but skip small numbers that are likely tag/title counts
      if (!data.erank_score) {
        const allMatches = [...pageText.matchAll(/(\d{1,3})\s*\/\s*100/g)];
        // Pick the largest match (score is usually higher than tag/title fraction numbers like "4/100")
        let bestScore = 0;
        for (const m of allMatches) {
          const num = parseInt(m[1]);
          if (num > bestScore && num <= 100) bestScore = num;
        }
        if (bestScore > 0) data.erank_score = bestScore;
      }

      // Extract Est. Sales
      const salesMatch = pageText.match(/Est(?:imated)?\.?\s*Sales[:\s]*([0-9,.]+[kKmM]?)/i);
      if (salesMatch) data.erank_est_sales = parseNum(salesMatch[1]);

      // Views
      const viewsMatch = pageText.match(/(?:Total\s+)?Views[:\s]*([0-9,.]+[kKmM]?)/i);
      if (viewsMatch) data.erank_views = parseNum(viewsMatch[1]);

      const dailyViewsMatch = pageText.match(/Daily\s*Views?[:\s]*([0-9,.]+)/i);
      if (dailyViewsMatch) data.erank_daily_views = parseNum(dailyViewsMatch[1]);

      const monthlyViewsMatch = pageText.match(/Monthly\s*Views?[:\s]*([0-9,.]+[kKmM]?)/i);
      if (monthlyViewsMatch) data.erank_monthly_views = parseNum(monthlyViewsMatch[1]);

      // Hearts/Favorites
      const heartsMatch = pageText.match(/(?:Hearts?|Favorites?)[:\s]*([0-9,.]+[kKmM]?)/i);
      if (heartsMatch) data.erank_hearts = parseNum(heartsMatch[1]);

      // Conversion Rate
      const convMatch = pageText.match(/Conversion\s*Rate[:\s]*([0-9.]+)%?/i);
      if (convMatch) data.erank_conversion_rate = parseFloat(convMatch[1]);

      // Title Length
      const titleLenMatch = pageText.match(/Title\s*(?:Length)?[:\s]*(\d+)\s*\/\s*140/i);
      if (titleLenMatch) data.erank_title_length = parseInt(titleLenMatch[1]);

      // Tags Count
      const tagsCountMatch = pageText.match(/Tags?[:\s]*(\d+)\s*\/\s*13/i);
      if (tagsCountMatch) data.erank_tags_count = parseInt(tagsCountMatch[1]);

      // Listing Age
      const ageMatch = pageText.match(/(?:Listing\s+)?Age[:\s]*(.+?)(?:\n|$)/i);
      if (ageMatch) data.erank_listing_age = ageMatch[1].trim().substring(0, 100);

      // Quantity
      const qtyMatch = pageText.match(/Quantity[:\s]*(\d+)/i);
      if (qtyMatch) data.erank_qty = parseInt(qtyMatch[1]);

      // Tags list — look for a tags section
      const tags = [];
      const tagElements = document.querySelectorAll('[class*="tag"], .badge, .label, [class*="Tag"]');
      tagElements.forEach(el => {
        const text = el.textContent.trim();
        if (text && text.length > 1 && text.length < 60 && !text.match(/^\d+$/) && !text.includes('Score')) {
          tags.push(text);
        }
      });

      // Also try to find tags in a specific section
      const tagSection = pageText.match(/Tags?\s*(?:\d+\s*\/\s*13)?\s*\n([\s\S]*?)(?:\n\n|\nTitle|\nDescription)/i);
      if (tagSection) {
        const tagLines = tagSection[1].split('\n').map(l => l.trim()).filter(l => l.length > 1 && l.length < 60);
        tagLines.forEach(t => {
          if (!tags.includes(t)) tags.push(t);
        });
      }

      data.tags_list = tags.join(', ');

      sendResponse({ success: true, data });
    } catch (err) {
      sendResponse({ success: false, error: err.message, data: {} });
    }
  }

  function parseNum(text) {
    if (!text) return 0;
    text = text.trim().replace(/,/g, '');
    const multiplierMatch = text.match(/([0-9.]+)\s*([kKmM])/);
    if (multiplierMatch) {
      const num = parseFloat(multiplierMatch[1]);
      const mult = multiplierMatch[2].toLowerCase() === 'k' ? 1000 : 1000000;
      return Math.round(num * mult);
    }
    return parseInt(text.replace(/[^0-9.-]/g, '')) || 0;
  }
})();
