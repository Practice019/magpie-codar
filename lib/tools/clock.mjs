// Timestamps in the client's own sentence.
//
// The captured reply was:
//   现在是 2026-11-21 06:42:59（CST，UTC+08:00），星期六。
// The zone is pinned to UTC+08:00 rather than taken from the host: a Chinese
// device in another timezone would otherwise answer a different hour for the
// same instant, and the client's own sentence says CST. The fields are derived
// from one time_t, so a second rolling over between them cannot make the
// sentence disagree with itself.
//
// A "星期" for a wrong day is the kind of error nobody catches by reading, so
// the weekday comes from the date's UTC midnight, not from a table indexed by
// a local day number that shifts with the host zone.

const CST_OFFSET_MS = 8 * 60 * 60 * 1000
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"]

const two = (n) => String(n).padStart(2, "0")

// cstFields splits an instant into the wall-clock fields of UTC+08:00.
export const cstFields = (instant = Date.now()) => {
  const shifted = new Date(new Date(instant).getTime() + CST_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth() + 1
  const day = shifted.getUTCDate()
  const hour = shifted.getUTCHours()
  const minute = shifted.getUTCMinutes()
  const second = shifted.getUTCSeconds()
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
  return { year, month, day, hour, minute, second, weekday }
}

// nowSentence is the reply's text, in full.
export const nowSentence = (instant = Date.now()) => {
  const t = cstFields(instant)
  return `现在是 ${t.year}-${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}:${two(t.second)}（CST，UTC+08:00），星期${t.weekday}。`
}

// stampFor is the same instant as a filename-safe stamp: 20261121-064259, the
// form the client uses when it saves over-long output to a file.
export const stampFor = (instant = Date.now()) => {
  const t = cstFields(instant)
  return `${t.year}${two(t.month)}${two(t.day)}-${two(t.hour)}${two(t.minute)}${two(t.second)}`
}
