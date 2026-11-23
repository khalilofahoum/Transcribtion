const assert = require('node:assert/strict');
const { correct } = require('../app/corrector.js');

const one = (text, lang, opts) => correct([{ text, lang }], opts).segments.map((s) => s.text).join(' ');
let passed = 0;
function check(name, actual, expected) {
  assert.equal(actual, expected, name);
  passed++;
}

// ---- English
check('stutter + filler', one('um so the the meeting is is tomorrow', 'en'), 'So the meeting is tomorrow.');
check('repeated phrase', one('i think i think we should go', 'en'), 'I think we should go.');
check('should of', one('i should of called you', 'en'), 'I should have called you.');
check('contractions', one('i dont know what thats about', 'en'), "I don't know what that's about.");
check('their/there', one('their is a problem over their', 'en'), 'There is a problem over there.');
check("your/you're", one('your welcome and your right', 'en'), "You're welcome and you're right.");
check('your right hand untouched', one('raise your right hand', 'en'), 'Raise your right hand.');
check("its/it's", one('its not working and its own battery died', 'en'), "It's not working and its own battery died.");
check('to/too', one('it was to late and to much for me', 'en'), 'It was too late and too much for me.');
check('than', one('this is better then that', 'en'), 'This is better than that.');
check('question', one('what is the plan for tomorrow', 'en'), 'What is the plan for tomorrow?');
check('question aux', one('do you know him', 'en'), 'Do you know him?');
check('statement stays', one('when i was young we lived there', 'en'), 'When I was young we lived there.');
check('keeps intended doubles', one('that was very very good', 'en'), 'That was very very good.');
check('keeps phone digits', one('call 5 5 2 1', 'en'), 'Call 5 5 2 1.');
check('existing punctuation kept', one('Hello there!', 'en'), 'Hello there!');

// ---- Hebrew
check('he im/am', one('עם אתה רוצה אני אבוא', 'he'), 'אם אתה רוצה אני אבוא.');
check('he with', one('דיברתי אם דני אתמול', 'he'), 'דיברתי עם דני אתמול.');
check('he split prefix', one('אמרתי ש אני בא', 'he'), 'אמרתי שאני בא.');
check('he question', one('למה לא באת אתמול', 'he'), 'למה לא באת אתמול?');
check('he relative not question', one('מה שאמרת זה נכון מאוד', 'he'), 'מה שאמרת זה נכון מאוד.');
check('he function-word stutter', one('אני אני רוצה ללכת של של דני', 'he'), 'אני רוצה ללכת של דני.');
check('he keeps idiom doubling', one('תלך לאט לאט', 'he'), 'תלך לאט לאט.');
check('he filler', one('אז אה הלכנו הביתה', 'he'), 'אז הלכנו הביתה.');
check('he final letter mid-word', one('שלוםם לכולם', 'he'), 'שלומם לכולם.');

// ---- Arabic
check('ar inshallah', one('انشاء الله بنشوفك بكرا', 'ar'), 'إن شاء الله بنشوفك بكرا.');
check('ar spelling', one('لاكن هاذا مش صحيح', 'ar'), 'لكن هذا مش صحيح.');
check('ar split prefix', one('راح و قال لي', 'ar'), 'راح وقال لي.');
check('ar question', one('كيف حالك اليوم', 'ar'), 'كيف حالك اليوم؟');
check('ar stutter', one('انا انا رايح على على البيت', 'ar'), 'انا رايح على البيت.');
check('ar keeps idiom doubling', one('امشي شوي شوي', 'ar'), 'امشي شوي شوي.');
check('ar tatweel + comma', one('مرحبـــا, كيفك', 'ar'), 'مرحبا، كيفك.');

// ---- options
check('fillers kept when off', one('um hello', 'en', { fillers: false }), 'Um hello.');
check('punctuation off', one('hello there', 'en', { punctuation: false }), 'hello there');

// ---- re-ranking: low-confidence phrase picks the alternative that fits the conversation
{
  const segs = [
    { text: 'the budget review is on Monday', lang: 'en', confidence: 0.95 },
    { text: 'we need the budget numbers first', lang: 'en', confidence: 0.93 },
    {
      text: 'send me the bucket', lang: 'en', confidence: 0.45,
      alternatives: [{ text: 'send me the bucket', confidence: 0.45 }, { text: 'send me the budget', confidence: 0.4 }],
    },
  ];
  const r = correct(segs);
  check('rerank', r.segments[2].text, 'Send me the budget.');
  assert.ok(r.changes.some((c) => c.rule === 'better alternative'));
  passed++;
}

// ---- consistency: a one-off spelling of a frequent name is unified
{
  const segs = [
    { text: 'I talked to Khalil today', lang: 'en' },
    { text: 'then Khalil said yes', lang: 'en' },
    { text: 'so we met Khalil again', lang: 'en' },
    { text: 'and I think Kalil agreed', lang: 'en' },
  ];
  check('name consistency', correct(segs).segments[3].text, 'And I think Khalil agreed.');
}
{
  const segs = [
    { text: 'הפרויקט של טכניון מתקדם', lang: 'he' },
    { text: 'נפגשנו ליד טכניון אתמול', lang: 'he' },
    { text: 'הסטודנטים של טכניון הגיעו', lang: 'he' },
    { text: 'ואז חזרנו אל תכניון בערב', lang: 'he' },
  ];
  check('he sound-alike consistency', correct(segs).segments[3].text, 'ואז חזרנו אל טכניון בערב.');
}

// ---- change log is reported
{
  const r = correct([{ text: 'i should of gone', lang: 'en' }]);
  assert.ok(r.changes.length >= 2);
  assert.ok(r.changes.every((c) => c.rule && c.before && c.after));
  passed++;
}

// ---- each change says which input segment it came from
{
  const r = correct([
    { text: 'hello there', lang: 'en' },
    { text: 'i should of gone', lang: 'en' },
    { text: 'עם אתה רוצה', lang: 'he' },
  ]);
  assert.ok(r.changes.length > 0);
  assert.ok(r.changes.every((c) => Number.isInteger(c.index)));
  assert.ok(r.changes.some((c) => c.rule === 'sound-alike' && c.index === 1));
  assert.ok(r.changes.some((c) => c.rule === 'עם/אם' && c.index === 2));
  assert.ok(r.segments.every((s) => !('_i' in s)));
  passed++;
}
{
  // extra fields on segments (like a recording id) are kept
  const r = correct([{ text: 'hi', lang: 'en', recId: 'abc' }]);
  check('keeps extra fields', r.segments[0].recId, 'abc');
}

console.log(`All ${passed} checks passed.`);
