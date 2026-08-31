/**
 * Bellek içi Prisma taklidi.
 *
 * Amaç: kullanıcı izolasyonu ve kota mantığını gerçek bir PostgreSQL kurmadan
 * test edebilmek. Sorgu davranışını tam olarak taklit etmez; sadece bu testlerde
 * kullanılan filtreleri (userId, tarih aralığı, ilişki üzerinden filtreleme) destekler.
 *
 * NOT: Bu, gerçek entegrasyon testlerinin yerini TUTMAZ. Prisma'nın kendi sorgu
 * üretimindeki bir hatayı yakalayamaz. Gerçek DB'ye karşı çalışan testler için
 * tests/integration.test.ts dosyasına bakın.
 */

let idCounter = 0;
const nextId = () => `id_${++idCounter}`;

interface Row {
  [key: string]: any;
}

class Table {
  rows: Row[] = [];

  create({ data }: { data: Row }) {
    const row = { id: data.id ?? nextId(), createdAt: new Date(), ...data };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  findFirst({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) {
    const matches = this.rows.filter((r) => matchWhere(r, where));
    if (orderBy) {
      const [key, dir] = Object.entries(orderBy)[0] as [string, string];
      matches.sort((a, b) =>
        dir === "desc" ? (b[key] > a[key] ? 1 : -1) : a[key] > b[key] ? 1 : -1
      );
    }
    return Promise.resolve(matches[0] ?? null);
  }

  findMany({ where, orderBy, take }: { where?: Row; orderBy?: Row; take?: number } = {}) {
    let matches = this.rows.filter((r) => matchWhere(r, where));
    if (orderBy) {
      const [key, dir] = Object.entries(orderBy)[0] as [string, string];
      matches.sort((a, b) =>
        dir === "desc" ? (b[key] > a[key] ? 1 : -1) : a[key] > b[key] ? 1 : -1
      );
    }
    if (take) matches = matches.slice(0, take);
    return Promise.resolve(matches);
  }

  count({ where }: { where?: Row } = {}) {
    return Promise.resolve(this.rows.filter((r) => matchWhere(r, where)).length);
  }

  update({ where, data }: { where: Row; data: Row }) {
    const row = this.rows.find((r) => matchWhere(r, where));
    if (row) Object.assign(row, data);
    return Promise.resolve(row);
  }

  deleteMany({ where }: { where?: Row } = {}) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matchWhere(r, where));
    return Promise.resolve({ count: before - this.rows.length });
  }

  reset() {
    this.rows = [];
  }
}

/** Basit where eşleştirici: eşitlik, in, gt/gte, not, OR ve ilişki üzerinden filtreleme. */
function matchWhere(row: Row, where?: Row): boolean {
  if (!where) return true;

  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as Row[]).some((c) => matchWhere(row, c))) return false;
      continue;
    }
    if (key === "NOT") {
      if (matchWhere(row, cond as Row)) return false;
      continue;
    }

    const value = row[key];

    if (cond === null) {
      if (value != null) return false;
      continue;
    }

    if (typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Row;
      if ("in" in c && !c.in.includes(value)) return false;
      if ("not" in c) {
        if (c.not === null) {
          if (value == null) return false;
        } else if (value === c.not) return false;
      }
      if ("gt" in c && !(value > c.gt)) return false;
      if ("gte" in c && !(value >= c.gte)) return false;
      if ("lt" in c && !(value < c.lt)) return false;

      // İlişki üzerinden filtreleme (örn. chatSession: { userId })
      const relationKeys = Object.keys(c).filter(
        (k) => !["in", "not", "gt", "gte", "lt"].includes(k)
      );
      if (relationKeys.length) {
        const related = row[`__${key}`];
        if (!related || !matchWhere(related, c)) return false;
      }
      continue;
    }

    if (cond instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false;
      continue;
    }

    if (value !== cond) return false;
  }

  return true;
}

export const mockPrisma = {
  user: new Table(),
  profile: new Table(),
  birthData: new Table(),
  reading: new Table(),
  chatSession: new Table(),
  chatMessage: new Table(),
  favorite: new Table(),
  subscription: new Table(),
  compatibilityCheck: new Table(),
  geocodeCache: new Table(),
  resetAll() {
    for (const v of Object.values(this)) {
      if (v instanceof Table) v.reset();
    }
  },
};

/** limits.ts'in import ettiği prisma modülünü mock ile değiştirir. */
export function installPrismaMock() {
  const path = require.resolve("../src/lib/prisma");
  require.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports: { prisma: mockPrisma },
  } as any;
}
