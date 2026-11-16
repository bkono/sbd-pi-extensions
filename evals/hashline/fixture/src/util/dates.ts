// Date helpers. Dates are ISO yyyy-mm-dd strings in UTC; no time zones.

export type IsoDate = string;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(value: string): Date {
  const m = ISO_RE.exec(value);
  if (!m) throw new RangeError(`not an ISO date: ${value}`);
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (date.toISOString().slice(0, 10) !== value) throw new RangeError(`invalid date: ${value}`);
  return date;
}

export function formatIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

export function addDays(value: IsoDate, days: number): IsoDate {
  const date = parseIsoDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatIsoDate(date);
}

export function isWeekend(value: IsoDate): boolean {
  const day = parseIsoDate(value).getUTCDay();
  return day === 0 || day === 6;
}

/** Fixed public holidays by region prefix (country). Month-day only. */
const HOLIDAYS: Record<string, readonly string[]> = {
  US: ["01-01", "07-04", "11-26", "12-25"],
  CA: ["01-01", "07-01", "12-25", "12-26"],
  DE: ["01-01", "05-01", "10-03", "12-25", "12-26"],
  FR: ["01-01", "05-01", "07-14", "12-25"],
  GB: ["01-01", "12-25", "12-26"],
  JP: ["01-01", "02-11", "05-03", "05-05", "11-03"],
  AU: ["01-01", "01-26", "04-25", "12-25", "12-26"],
};

export function isHolidayIn(regionCode: string, value: IsoDate): boolean {
  const country = regionCode.split("-")[0] ?? regionCode;
  const list = HOLIDAYS[country];
  if (!list) return false;
  return list.includes(value.slice(5));
}

export function isBusinessDay(regionCode: string, value: IsoDate): boolean {
  return !isWeekend(value) && !isHolidayIn(regionCode, value);
}

/** Adds `days` business days in `regionCode`, skipping weekends and holidays. */
export function addBusinessDays(regionCode: string, value: IsoDate, days: number): IsoDate {
  if (days < 0) throw new RangeError("addBusinessDays: negative days");
  let current = value;
  let remaining = days;
  while (remaining > 0) {
    current = addDays(current, 1);
    if (isBusinessDay(regionCode, current)) remaining -= 1;
  }
  return current;
}

export function businessDaysBetween(regionCode: string, from: IsoDate, to: IsoDate): number {
  if (to < from) return -businessDaysBetween(regionCode, to, from);
  let count = 0;
  let current = from;
  while (current < to) {
    current = addDays(current, 1);
    if (isBusinessDay(regionCode, current)) count += 1;
  }
  return count;
}

export function compareIsoDate(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isWithin(value: IsoDate, from: IsoDate, to: IsoDate): boolean {
  return value >= from && value <= to;
}
