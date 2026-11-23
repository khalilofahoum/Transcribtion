/*
 * Transcript correction engine (English / Hebrew / Arabic).
 *
 * Runs over the finished transcript in four stages:
 *   1. Re-rank   - for low-confidence phrases, pick the recognizer alternative
 *                  that best fits the vocabulary of the rest of the conversation.
 *   2. Clean     - remove fillers and stutters, re-attach split prefixes,
 *                  fix letter forms.
 *   3. Context   - language-specific rules for words that sound alike
 *                  (their/there, עם/אם, common Arabic misspellings, ...).
 *   4. Consistency - a word that appears once and differs from a frequent word
 *                  only by a sound-alike letter is unified with the frequent one.
 * Finally sentences are capitalized and punctuated.
 *
 * Works in the browser (window.Corrector) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Corrector = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const L = '\\p{L}\\p{M}\\p{N}';
  const B0 = `(?<![${L}'])`; // not preceded by a letter/digit/apostrophe
  const B1 = `(?![${L}])`; // not followed by a letter/digit

  function matchCase(src, out) {
    if (!src || !out) return out;
    const c = src[0];
    if (c !== c.toLowerCase()) return out[0].toUpperCase() + out.slice(1);
    return out;
  }

  // Replace whole-word pattern, keep the original capitalization, log the change.
  function sub(ctx, pattern, repl, rule) {
    const re = new RegExp(B0 + '(?:' + pattern + ')' + B1, 'giu');
    ctx.text = ctx.text.replace(re, (...args) => {
      const m = args[0];
      const groups = args.slice(1, args.length - 2);
      let out = repl.replace(/\$(\d)/g, (_, n) => groups[n - 1] || '');
      out = matchCase(m, out);
      if (out !== m) ctx.changes.push({ rule, before: m, after: out || '(removed)' });
      return out;
    });
  }

  function tidy(text) {
    return text
      .replace(/\s+/g, ' ')
      .replace(/\s+([.,!?;:،؟])/g, '$1')
      .replace(/([,،])(\s*[,،])+/g, '$1')
      .replace(/^[\s,،.]+/, '')
      .trim();
  }

  // ---------------------------------------------------------------- fillers
  const FILLERS = {
    en: '(?:um+|uh+|uhm+|erm+|hm+)[,.]?',
    he: '(?:אה+|אמ+|אהמ+)[,.]?',
    ar: '(?:امم+|ممم+|اا+)[,،.]?',
  };

  // ---------------------------------------------------------------- stutters
  // English: any immediately repeated word is a stutter unless it is a normal doubling.
  const EN_KEEP_DOUBLE = new Set(('that had very really so no yes bye ha blah knock long far many much ' +
    'zero oh one two three four five six seven eight nine').split(' '));
  // Hebrew/Arabic use doubling for meaning (לאט לאט, شوي شوي), so only function words are collapsed.
  const FUNCTION_WORDS = {
    he: new Set('של את על עם אם זה זאת אני אתה הוא היא אנחנו הם כי אבל או גם אז כאילו יש אין אל מן עד כמו רק עוד מה ש כש'.split(' ')),
    ar: new Set('في من على الى إلى عن مع هذا هذه انا أنا هو هي نحن يعني و بس او أو ان أن إن اللي التي الذي كان لما اذا إذا عشان هاد هاي'.split(' ')),
  };

  const key = (t) => t.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const endsPunct = (t) => /[.,!?;:،؟]$/.test(t);

  function dedupe(ctx, lang) {
    let tokens = ctx.text.split(/\s+/).filter(Boolean);
    // repeated phrases of 3 or 2 words: "I think I think" -> "I think"
    for (const n of [3, 2]) {
      for (let i = 0; i + 2 * n <= tokens.length; ) {
        let same = true;
        for (let j = 0; j < n; j++) {
          const a = key(tokens[i + j]);
          if (!a || a !== key(tokens[i + n + j]) || endsPunct(tokens[i + j])) { same = false; break; }
        }
        if (same) {
          const phrase = tokens.slice(i, i + n).join(' ');
          ctx.changes.push({ rule: 'repeated phrase', before: phrase + ' ' + phrase, after: phrase });
          tokens.splice(i, n);
        } else i++;
      }
    }
    // repeated single words: "the the" -> "the"
    for (let i = 0; i + 1 < tokens.length; ) {
      const a = key(tokens[i]);
      const stutter = a && a === key(tokens[i + 1]) && !endsPunct(tokens[i]) && !/^\d+$/.test(a) &&
        (lang === 'en' ? !EN_KEEP_DOUBLE.has(a) : FUNCTION_WORDS[lang].has(a));
      if (stutter) {
        ctx.changes.push({ rule: 'repeated word', before: tokens[i] + ' ' + tokens[i + 1], after: tokens[i + 1] });
        tokens.splice(i, 1);
      } else i++;
    }
    ctx.text = tokens.join(' ');
  }

  // ---------------------------------------------------------------- English
  const EN_CONTRACTIONS = {
    dont: "don't", cant: "can't", wont: "won't", didnt: "didn't", doesnt: "doesn't", isnt: "isn't",
    arent: "aren't", wasnt: "wasn't", werent: "weren't", couldnt: "couldn't", shouldnt: "shouldn't",
    wouldnt: "wouldn't", havent: "haven't", hasnt: "hasn't", hadnt: "hadn't", im: "I'm", ive: "I've",
    youre: "you're", theyre: "they're", thats: "that's", whats: "what's", theres: "there's",
  };

  const EN_RULES = [
    // [pattern, replacement, label]
    ['i', 'I', 'capital I'],
    ['(should|could|would|must|might) of', '$1 have', 'sound-alike'],
    ['alot', 'a lot', 'spelling'],
    ['suppose to', 'supposed to', 'grammar'],
    ['(I|you|he|she|we|they) use to', '$1 used to', 'grammar'],
    // their / there / they're
    ["their (is|are|was|were|isn't|aren't|wasn't|weren't|will be)", 'there $1', 'their/there'],
    ["(?:there|they're) own", 'their own', 'their/there'],
    ['their (going to|gonna|not|coming|trying|doing|saying)', "they're $1", "their/they're"],
    ['there (going to|gonna|trying to)', "they're $1", "there/they're"],
    ['(over|out|in|up|down|right) their(?=\\s*(?:$|[.,!?]))', '$1 there', 'their/there'],
    // your / you're
    ['your (welcome|kidding|gonna|going to|not|wrong|a|an|the)', "you're $1", "your/you're"],
    ['your right(?=\\s*(?:$|[.,!?]))', "you're right", "your/you're"],
    ["you're (own|name|phone|car|house|turn|fault|idea|job|family|friend|mother|father|mom|dad)", 'your $1', "your/you're"],
    // its / it's
    ['its (a|an|the|not|been|going|gonna|so|really|just|okay|ok|fine|true|time to|about|too|because|like)', "it's $1", "its/it's"],
    ["it's own", 'its own', "its/it's"],
    // to / too
    ["(way|far|is|was|are|were|it's|that's|not|be|been|got|getting|a bit|a little) to (much|many|late|early|bad|hard|easy|expensive|soon|big|small|long|short|fast|slow|hot|cold|loud|tired|busy)", '$1 too $2', 'to/too'],
    ['to much', 'too much', 'to/too'],
    ['me to(?=\\s*(?:$|[.,!?]))', 'me too', 'to/too'],
    // then / than
    ['(more|less|better|worse|rather|bigger|smaller|faster|slower|higher|lower|greater|fewer|older|younger|easier|harder|longer|shorter|other) then', '$1 than', 'then/than'],
    // lose / loose, affect / effect
    ["(going to|gonna|will|to|don't|didn't|can't|won't|not) loose(?! (?:ends?|change))", '$1 lose', 'loose/lose'],
    ['(an|the|no|any|side|same|big|huge|positive|negative) affect(s?)', '$1 effect$2', 'affect/effect'],
  ];

  function fixEnglish(ctx) {
    ctx.text = ctx.text.replace(/[’‘]/g, "'");
    const re = new RegExp(B0 + '(' + Object.keys(EN_CONTRACTIONS).join('|') + ')' + B1, 'giu');
    ctx.text = ctx.text.replace(re, (m) => {
      const out = matchCase(m, EN_CONTRACTIONS[m.toLowerCase()]);
      ctx.changes.push({ rule: 'contraction', before: m, after: out });
      return out;
    });
    for (const [p, r, label] of EN_RULES) sub(ctx, p, r, label);
  }

  const EN_QUESTION = new RegExp('^(?:' + [
    "(?:is|are|was|were|do|does|did|can|could|would|should|will|have|has|am|shall|isn't|aren't|don't|doesn't|didn't|can't|won't|wouldn't|couldn't|shouldn't) (?:i|you|he|she|it|we|they|this|that|there|these|those|the|my|your|anyone|anybody|someone)\\b",
    '(?:what|why|how|when|where|who|whose) (?:is|are|was|were|do|does|did|can|could|would|should|will|have|has|am|about|if)\\b',
    "(?:what|who|how|where|when|why)'s\\b",
    'how (?:much|many|long|often|old|far|come)\\b',
    'what (?:time|kind|type|sort|happened|else)\\b',
    'which (?:one|ones)\\b',
    'why not\\b',
  ].join('|') + ')', 'i');

  // ---------------------------------------------------------------- Hebrew
  const HE_FINALS = { 'ם': 'מ', 'ן': 'נ', 'ץ': 'צ', 'ף': 'פ', 'ך': 'כ' };
  const HE_SUBJECT = 'אני|אתה|את|הוא|היא|אנחנו|אתם|אתן|הם|הן';
  const HE_RULES = [
    // "עם" (with) can never be followed by a subject pronoun -> the speaker said "אם" (if)
    [`עם (${HE_SUBJECT})`, 'אם $1', 'עם/אם'],
    // ... and these verbs/expressions always take "עם" (with)
    ['(ביחד|יחד|לדבר|מדבר|מדברת|מדברים|דיברתי|דיבר|דיברה|דיברנו|להיפגש|נפגשתי|נפגש|נפגשנו|בקשר|להתייעץ) אם', '$1 עם', 'אם/עם'],
    ['אם כל הכבוד', 'עם כל הכבוד', 'אם/עם'],
    ['אם כל זה', 'עם כל זה', 'אם/עם'],
  ];

  function fixHebrew(ctx) {
    // final-form letter in the middle of a word is always a mistake
    ctx.text = ctx.text.replace(/[םןץףך](?=[א-ת])/g, (c) => {
      ctx.changes.push({ rule: 'letter form', before: c, after: HE_FINALS[c] });
      return HE_FINALS[c];
    });
    // a prefix letter standing alone belongs to the next word: "ש אני" -> "שאני"
    ctx.text = ctx.text.replace(/(^|\s)(כש|[ובלמשהכ])\s+(?=[א-ת]{2})/g, (m, pre, letter) => {
      ctx.changes.push({ rule: 'split prefix', before: letter + ' …', after: letter + '…' });
      return pre + letter;
    });
    for (const [p, r, label] of HE_RULES) sub(ctx, p, r, label);
  }

  const HE_QUESTION = /^(?:(?:למה|האם|לאן|מאיפה|מדוע)(?=\s|$)|(?:מה|איך|מתי|איפה|מי)(?:\s+(?!ש)|$))|(?:^|\s)נכון$/;

  // ---------------------------------------------------------------- Arabic
  const AR_RULES = [
    ['(?:ان ?شاء ?الله|إنشاء ?الله|انشالله|إنشالله)', 'إن شاء الله', 'spelling'],
    ['لاكن', 'لكن', 'spelling'],
    ['هاذا', 'هذا', 'spelling'],
    ['هاذه', 'هذه', 'spelling'],
    ['ذالك', 'ذلك', 'spelling'],
    ['هاؤلاء', 'هؤلاء', 'spelling'],
    ['الذى', 'الذي', 'spelling'],
  ];

  function fixArabic(ctx) {
    ctx.text = ctx.text.replace(/ـ+/g, ''); // tatweel (stretching)
    // a one-letter particle standing alone belongs to the next word: "و قال" -> "وقال"
    ctx.text = ctx.text.replace(/(^|\s)([وفبلك])\s+(?=[ء-ي]{2})/g, (m, pre, letter) => {
      ctx.changes.push({ rule: 'split prefix', before: letter + ' …', after: letter + '…' });
      return pre + letter;
    });
    for (const [p, r, label] of AR_RULES) sub(ctx, p, r, label);
    ctx.text = ctx.text.replace(/,(?!\d)/g, '،').replace(/\?/g, '؟').replace(/;/g, '؛');
  }

  const AR_QUESTION = /^(?:هل|ماذا|لماذا|كيف|متى|أين|اين|وين|ليش|شو|ايش|إيش|مين|كيفك|قديش|ليه|فين|ازاي|إزاي)(?=\s|$)|(?:^|\s)صح$/;

  // ---------------------------------------------------------------- punctuation
  function punctuate(text, lang) {
    if (!text) return text;
    if (lang === 'en') {
      text = text.replace(/(^|[.!?]\s+)(\p{Ll})/gu, (m, pre, c) => pre + c.toUpperCase());
    }
    if (/[.!?…؟:;,،]$/.test(text)) return text;
    const isQuestion = (lang === 'en' ? EN_QUESTION : lang === 'he' ? HE_QUESTION : AR_QUESTION).test(text);
    return text + (isQuestion ? (lang === 'ar' ? '؟' : '?') : '.');
  }

  // ---------------------------------------------------------------- stage 1: re-rank alternatives
  const contentWords = (t) => t.toLowerCase().match(/[\p{L}\p{M}]{3,}/gu) || [];

  function rerank(segments, changes) {
    const vocab = new Map();
    for (const s of segments) {
      const c = s.confidence || 0;
      if (c >= 0.85 || c === 0) for (const w of new Set(contentWords(s.text))) vocab.set(w, (vocab.get(w) || 0) + 1);
    }
    return segments.map((s) => {
      const alts = s.alternatives || [];
      const conf = s.confidence || 0;
      if (alts.length < 2 || conf >= 0.8) return s;
      const own = conf === 0 ? new Set(contentWords(s.text)) : new Set();
      const score = (text) => {
        const ws = contentWords(text);
        if (!ws.length) return 0;
        let hit = 0;
        for (const w of ws) if ((vocab.get(w) || 0) - (own.has(w) ? 1 : 0) > 0) hit++;
        return hit / ws.length;
      };
      const base = score(alts[0].text);
      const margin = conf === 0 ? 0.34 : 0.25;
      let best = null, bestScore = base + margin;
      for (const a of alts.slice(1)) {
        const sc = score(a.text);
        if (sc >= bestScore) { best = a; bestScore = sc; }
      }
      if (!best) return s;
      changes.push({ rule: 'better alternative', before: s.text, after: best.text });
      return Object.assign({}, s, { text: best.text });
    });
  }

  // ---------------------------------------------------------------- stage 4: consistency
  const CONFUSABLE = {
    he: ['טת', 'כק', 'חכ', 'אע', 'סש', 'בו'],
    ar: ['صس', 'ضد', 'طت', 'ظذز', 'قك', 'ثس', 'ةه', 'ىي', 'اأإآ'],
  };

  function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  function soundAlike(a, b, lang) {
    if (a.length !== b.length) return false;
    let diff = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) { if (diff >= 0) return false; diff = i; }
    }
    return diff >= 0 && CONFUSABLE[lang].some((g) => g.includes(a[diff]) && g.includes(b[diff]));
  }

  function unify(segments, changes) {
    const counts = { en: new Map(), he: new Map(), ar: new Map() };
    for (const s of segments) {
      const tokens = s.text.split(/\s+/);
      tokens.forEach((raw, i) => {
        const w = raw.replace(/^[^\p{L}]+|[^\p{L}']+$/gu, '').replace(/'s$/, '');
        if (w.length < 4) return;
        if (s.lang === 'en') {
          // names only: capitalized words that are not at the start of a sentence
          const sentenceStart = i === 0 || /[.!?]$/.test(tokens[i - 1]);
          if (sentenceStart || !/^\p{Lu}\p{Ll}+$/u.test(w)) return;
        }
        counts[s.lang].set(w, (counts[s.lang].get(w) || 0) + 1);
      });
    }
    const fixes = { en: new Map(), he: new Map(), ar: new Map() };
    for (const lang of ['en', 'he', 'ar']) {
      const frequent = [...counts[lang]].filter(([, n]) => n >= 3).map(([w]) => w);
      for (const [w, n] of counts[lang]) {
        if (n !== 1) continue;
        const target = frequent.find((f) => {
          if (f === w) return false;
          if (lang !== 'en') return soundAlike(w, f, lang);
          const a = w.toLowerCase(), b = f.toLowerCase();
          return a[0] === b[0] && a !== b + 's' && b !== a + 's' && editDistance(a, b) <= (a.length >= 6 ? 2 : 1);
        });
        if (target) fixes[lang].set(w, target);
      }
    }
    return segments.map((s) => {
      let text = s.text;
      for (const [w, target] of fixes[s.lang]) {
        const re = new RegExp(B0 + w + B1, 'gu');
        if (re.test(text)) {
          text = text.replace(re, target);
          changes.push({ rule: 'consistency', before: w, after: target });
        }
      }
      return text === s.text ? s : Object.assign({}, s, { text });
    });
  }

  // ---------------------------------------------------------------- pipeline
  function correctText(text, lang, opts, changes) {
    const ctx = { text: tidy(text.normalize('NFC').replace(/[​-‏‪-‮﻿]/g, '')), changes };
    if (opts.fillers !== false) { sub(ctx, FILLERS[lang], '', 'filler'); ctx.text = tidy(ctx.text); }
    dedupe(ctx, lang);
    if (lang === 'en') fixEnglish(ctx);
    else if (lang === 'he') fixHebrew(ctx);
    else fixArabic(ctx);
    return tidy(ctx.text);
  }

  /**
   * segments: [{ text, lang: 'en'|'he'|'ar', confidence?, alternatives?: [{text, confidence}] }]
   * returns { segments (same shape, corrected text), changes: [{rule, before, after}] }
   */
  function correct(segments, opts) {
    opts = opts || {};
    const changes = [];
    let out = rerank(segments, changes);
    out = out.map((s) => Object.assign({}, s, { text: correctText(s.text, s.lang, opts, changes) })).filter((s) => s.text);
    out = unify(out, changes);
    if (opts.punctuation !== false) out = out.map((s) => Object.assign({}, s, { text: punctuate(s.text, s.lang) }));
    return { segments: out, changes };
  }

  return { correct, correctText, punctuate };
});
