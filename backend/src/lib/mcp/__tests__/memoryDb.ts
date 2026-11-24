// A small in-memory stand-in for the supabase-js query builder, enough for
// the connector tables the app-mode tests touch.
import { randomUUID } from "node:crypto";
import type { Db } from "../types";

type Row = Record<string, unknown>;

export function memoryDb(initial: Record<string, Row[]> = {}) {
    const tables = new Map<string, Row[]>(Object.entries(initial).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
    const rowsOf = (table: string) => {
        if (!tables.has(table)) tables.set(table, []);
        return tables.get(table)!;
    };
    const db = {
        tables,
        rpc() {
            return Promise.resolve({ data: null, error: null });
        },
        from(table: string) {
            const rows = rowsOf(table);
            let action: "select" | "insert" | "upsert" | "update" | "delete" = "select";
            let payload: Row[] = [];
            let patch: Row = {};
            let conflict: string[] = [];
            let single: "one" | "maybe" | null = null;
            const filters: ((row: Row) => boolean)[] = [];
            const query: Record<string, unknown> = {
                select() {
                    return query;
                },
                eq(key: string, value: unknown) {
                    filters.push((r) => r[key] === value);
                    return query;
                },
                in(key: string, values: unknown[]) {
                    filters.push((r) => values.includes(r[key]));
                    return query;
                },
                gt(key: string, value: string) {
                    filters.push((r) => String(r[key]) > value);
                    return query;
                },
                lt(key: string, value: string) {
                    filters.push((r) => String(r[key]) < value);
                    return query;
                },
                not() {
                    return query;
                },
                order() {
                    return query;
                },
                limit() {
                    return query;
                },
                filter(key: string, op: string, value: unknown) {
                    filters.push((r) => (op === "is" ? (r[key] ?? null) === value : r[key] === value));
                    return query;
                },
                single() {
                    single = "one";
                    return query;
                },
                maybeSingle() {
                    single = "maybe";
                    return query;
                },
                insert(value: Row | Row[]) {
                    action = "insert";
                    payload = Array.isArray(value) ? value : [value];
                    return query;
                },
                upsert(value: Row | Row[], options?: { onConflict?: string }) {
                    action = "upsert";
                    payload = Array.isArray(value) ? value : [value];
                    conflict = (options?.onConflict ?? "id").split(",");
                    return query;
                },
                update(value: Row) {
                    action = "update";
                    patch = value;
                    return query;
                },
                delete() {
                    action = "delete";
                    return query;
                },
                then(resolve: (value: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
                    try {
                        return Promise.resolve(run()).then(resolve, reject);
                    } catch (error) {
                        return Promise.reject(error).catch(reject);
                    }
                },
            };
            const matching = () => rows.filter((r) => filters.every((f) => f(r)));
            const answer = (found: Row[]) => {
                if (single === "one")
                    return found.length === 1
                        ? { data: { ...found[0] }, error: null }
                        : { data: null, error: { code: "PGRST116", message: "not one row" } };
                if (single === "maybe") return { data: found[0] ? { ...found[0] } : null, error: null };
                return { data: found.map((r) => ({ ...r })), error: null };
            };
            const run = () => {
                if (action === "select") return answer(matching());
                if (action === "insert") {
                    const added = payload.map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...r }));
                    rows.push(...added);
                    return answer(added);
                }
                if (action === "upsert") {
                    const out: Row[] = [];
                    for (const r of payload) {
                        const existing = rows.find((x) => conflict.every((k) => x[k] === r[k]));
                        if (existing) {
                            Object.assign(existing, r);
                            out.push(existing);
                        } else {
                            const added = { id: randomUUID(), created_at: new Date().toISOString(), ...r };
                            rows.push(added);
                            out.push(added);
                        }
                    }
                    return answer(out);
                }
                if (action === "update") {
                    const found = matching();
                    for (const r of found) Object.assign(r, patch);
                    return answer(found);
                }
                const found = matching();
                for (const r of found) rows.splice(rows.indexOf(r), 1);
                return answer(found);
            };
            return query;
        },
    };
    return db as unknown as Db & { tables: Map<string, Row[]> };
}
