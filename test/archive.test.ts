import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archivePath, listArchive, readArchive, writeArchive } from "../src/ingest/archive";

const LOG = path.join(os.tmpdir(), "am-live", "session.jsonl");
const line = (n: number) => `${JSON.stringify({ n, text: `synthetic line ${n} `.repeat(20) })}\n`;
const lines = (from: number, to: number) => Buffer.from(Array.from({ length: to - from }, (_, i) => line(from + i)).join(""));

describe("archive copies", () => {
  let dir: string;
  let target: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-archive-"));
    target = archivePath(dir, "fake", LOG);
  });

  it("reads concatenated gzip members back as one stream", async () => {
    const a = Buffer.from("first member\n");
    const b = Buffer.from("second member\n");
    const both = Buffer.concat([zlib.gzipSync(a), zlib.gzipSync(b)]);
    expect((await promisify(zlib.gunzip)(both)).toString()).toBe("first member\nsecond member\n");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, both);
    expect((await readArchive(target)).toString()).toBe("first member\nsecond member\n");
  });

  it("keeps the complete members when a crash truncated the last append", async () => {
    const first = lines(0, 50);
    const tail = zlib.gzipSync(lines(50, 100));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.concat([zlib.gzipSync(first), tail.subarray(0, Math.floor(tail.length / 2))]));
    const read = await readArchive(target);
    expect(read.subarray(0, first.length).equals(first)).toBe(true);
    expect(read.length).toBeLessThan(lines(0, 100).length);
  });

  it("appends only the new bytes of a grown log", async () => {
    const first = lines(0, 50);
    const s1 = await writeArchive(dir, "fake", LOG, first);
    const gz1 = fs.readFileSync(target);
    expect(s1).toMatchObject({ size: first.length, gzSize: gz1.length });

    const grown = Buffer.concat([first, lines(50, 60)]);
    const s2 = await writeArchive(dir, "fake", LOG, grown, s1);
    const gz2 = fs.readFileSync(target);
    expect(gz2.subarray(0, gz1.length).equals(gz1)).toBe(true);
    expect(gz2.length).toBe(gz1.length + zlib.gzipSync(lines(50, 60)).length);
    expect(s2).toMatchObject({ size: grown.length, gzSize: gz2.length });
    expect((await readArchive(target)).equals(grown)).toBe(true);

    // Same bytes again (e.g. only the mtime changed): nothing is written.
    expect(await writeArchive(dir, "fake", LOG, grown, s2)).toEqual(s2);
    expect(fs.readFileSync(target).equals(gz2)).toBe(true);
  });

  it("rewrites the copy when the archived prefix changed", async () => {
    const first = lines(0, 50);
    const s1 = await writeArchive(dir, "fake", LOG, first);
    const gz1 = fs.readFileSync(target);
    // The tool rewrote an earlier line in place (omp rewrites its title line) and appended more.
    const rewritten = Buffer.concat([Buffer.from(line(999)), first.subarray(line(0).length), lines(50, 60)]);
    const s2 = await writeArchive(dir, "fake", LOG, rewritten, s1);
    const gz2 = fs.readFileSync(target);
    expect(gz2.subarray(0, gz1.length).equals(gz1)).toBe(false);
    expect(s2.gzSize).toBe(gz2.length);
    expect((await readArchive(target)).equals(rewritten)).toBe(true);

    // A log that shrank is rewritten too.
    const shrunk = lines(0, 10);
    await writeArchive(dir, "fake", LOG, shrunk, s2);
    expect((await readArchive(target)).equals(shrunk)).toBe(true);
  });

  it("rewrites the copy when the .gz is not as it was left (torn append, foreign write)", async () => {
    const first = lines(0, 50);
    const s1 = await writeArchive(dir, "fake", LOG, first);
    // An append that crashed halfway: half a gzip member at the end.
    fs.appendFileSync(target, zlib.gzipSync(lines(50, 55)).subarray(0, 20));
    const grown = Buffer.concat([first, lines(50, 60)]);
    const s2 = await writeArchive(dir, "fake", LOG, grown, s1);
    expect(s2.gzSize).toBe(fs.statSync(target).size);
    expect((await readArchive(target)).equals(grown)).toBe(true);
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const write = (gz: Buffer) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, gz);
  };

  it("keeps every complete member when the torn tail is no gzip member at all", async () => {
    const first = lines(0, 2000);
    const second = lines(2000, 2100);
    const members = Buffer.concat([zlib.gzipSync(first), zlib.gzipSync(second)]);
    // A member that lost its header (only its deflate data and trailer remain), then plain garbage.
    write(Buffer.concat([members, zlib.gzipSync(lines(2100, 2200)).subarray(10)]));
    expect((await readArchive(target)).equals(Buffer.concat([first, second]))).toBe(true);
    write(Buffer.concat([members, Buffer.from("garbage")]));
    expect((await readArchive(target)).equals(Buffer.concat([first, second]))).toBe(true);
    // A cut through the header of the last member.
    write(Buffer.concat([members, Buffer.from([0x1f, 0x8b, 0x08])]));
    expect((await readArchive(target)).equals(Buffer.concat([first, second]))).toBe(true);
  });

  it("reads as much of a truncated last member as its bytes hold, and fails when nothing decodes", async () => {
    const first = lines(0, 50);
    const tail = zlib.gzipSync(lines(50, 2000));
    write(Buffer.concat([zlib.gzipSync(first), tail.subarray(0, Math.floor(tail.length / 2))]));
    const read = await readArchive(target);
    expect(read.length).toBeGreaterThan(first.length);
    expect(lines(0, 2000).subarray(0, read.length).equals(read)).toBe(true);

    write(Buffer.from("not gzip"));
    await expect(readArchive(target)).rejects.toThrow();
    write(Buffer.alloc(0));
    await expect(readArchive(target)).rejects.toThrow();
  });

  it("rewrites the copy when another process appended the same tail at the same time", async () => {
    const first = lines(0, 50);
    const s1 = await writeArchive(dir, "fake", LOG, first);
    const grown = Buffer.concat([first, lines(50, 60)]);
    // Both passed the size check; the other process's append lands just before ours.
    const append = fsp.appendFile.bind(fsp);
    const spy = vi.spyOn(fsp, "appendFile").mockImplementationOnce(async (file, data) => {
      await append(file, data);
      await append(file, data);
    });
    const s2 = await writeArchive(dir, "fake", LOG, grown, s1);
    expect(spy).toHaveBeenCalledOnce();
    expect((await readArchive(target)).equals(grown)).toBe(true);
    expect(s2).toMatchObject({ size: grown.length, gzSize: fs.statSync(target).size });
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // The state it returned is right: the next append goes through.
    const more = Buffer.concat([grown, lines(60, 70)]);
    const s3 = await writeArchive(dir, "fake", LOG, more, s2);
    expect(s3.gzSize).toBe(s2.gzSize + zlib.gzipSync(lines(60, 70)).length);
    expect((await readArchive(target)).equals(more)).toBe(true);
  });

  it("keeps the replaced copy next to the new one when the log lost or changed what the copy held", async () => {
    const sidecars = () => fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith(".prev")).sort();
    const first = lines(0, 50);
    const s1 = await writeArchive(dir, "fake", LOG, first);
    // Appends and a rewrite over a torn .gz lose nothing: no sidecar.
    const s2 = await writeArchive(dir, "fake", LOG, Buffer.concat([first, lines(50, 60)]), s1);
    fs.appendFileSync(target, Buffer.from([0x1f]));
    const grown = Buffer.concat([first, lines(50, 70)]);
    const s3 = await writeArchive(dir, "fake", LOG, grown, s2);
    expect(sidecars()).toEqual([]);

    // The tool pruned its log: the copy that held all 70 lines is kept.
    const pruned = lines(60, 70);
    const s4 = await writeArchive(dir, "fake", LOG, pruned, s3);
    expect((await readArchive(target)).equals(pruned)).toBe(true);
    expect(sidecars()).toHaveLength(1);
    expect((await readArchive(path.join(path.dirname(target), sidecars()[0]))).equals(grown)).toBe(true);

    // An earlier part rewritten while the log kept growing: one rolling copy, however often it happens.
    const s5 = await writeArchive(dir, "fake", LOG, Buffer.concat([Buffer.from(line(999)), lines(61, 80)]), s4);
    expect(sidecars()).toHaveLength(2);
    const rewritten = Buffer.concat([Buffer.from(line(998)), lines(61, 90)]);
    await writeArchive(dir, "fake", LOG, rewritten, s5);
    expect(sidecars()).toHaveLength(2);
    expect(sidecars()).toContain(`${path.basename(target)}.prev`);
    expect((await readArchive(target)).equals(rewritten)).toBe(true);

    // Listing the archive skips them.
    const listed = [];
    for await (const entry of listArchive(dir)) listed.push(entry.file);
    expect(listed).toEqual([target]);
  });
});
