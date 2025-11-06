// scripts/utils/time.js
export function isoWeekKey(isoDate) {
  const d = new Date(isoDate + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  const thurs = new Date(d);
  thurs.setUTCDate(d.getUTCDate() - day + 3);
  const week1 = new Date(Date.UTC(thurs.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((thurs - week1) / 604800000);
  const year = thurs.getUTCFullYear();
  return `${year}-W${String(week).padStart(2,'0')}`;
}

export function weeksToBounds(weekKey) {
  const [y, w] = weekKey.split("-W").map(Number);
  const simple = new Date(Date.UTC(y, 0, 1 + (w - 1) * 7));
  const dow = (simple.getUTCDay() + 6) % 7;
  const monday = new Date(simple);
  monday.setUTCDate(simple.getUTCDate() - dow);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    start: monday.toISOString().slice(0,10),
    end: sunday.toISOString().slice(0,10)
  };
}

export function quarterBounds(year, q) {
  const starts = ["01-01","04-01","07-01","10-01"];
  const ends   = ["03-31","06-30","09-30","12-31"];
  return {
    start: `${year}-${starts[q-1]}`,
    end:   `${year}-${ends[q-1]}`
  };
}
