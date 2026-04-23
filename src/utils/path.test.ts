import { describe, test, expect } from "vitest";
import { bumpName, joinPath } from "./path";

describe("bumpName", () => {
  test("adds (1) to a file with extension", () => {
    expect(bumpName("/home/foo.txt")).toBe("/home/foo (1).txt");
  });

  test("increments existing (N) suffix", () => {
    expect(bumpName("/home/foo (1).txt")).toBe("/home/foo (2).txt");
    expect(bumpName("/home/foo (9).txt")).toBe("/home/foo (10).txt");
    expect(bumpName("/home/foo (99).txt")).toBe("/home/foo (100).txt");
  });

  test("handles file without extension", () => {
    expect(bumpName("/home/README")).toBe("/home/README (1)");
    expect(bumpName("/home/README (1)")).toBe("/home/README (2)");
  });

  test("handles bare filename (no path)", () => {
    expect(bumpName("foo.txt")).toBe("foo (1).txt");
    expect(bumpName("README")).toBe("README (1)");
  });

  test("multi-dot: keeps only last extension", () => {
    // 단일 확장자만 보존하는 단순 정책 — archive.tar 가 name, .gz 가 ext.
    expect(bumpName("/a/archive.tar.gz")).toBe("/a/archive.tar (1).gz");
  });

  test("dotfile (.bashrc) keeps leading dot as part of name", () => {
    // 선두 dot 은 확장자로 취급하지 않음.
    expect(bumpName(".bashrc")).toBe(".bashrc (1)");
    expect(bumpName("/home/user/.bashrc")).toBe("/home/user/.bashrc (1)");
  });

  test("directory (no extension) also works", () => {
    expect(bumpName("/home/project")).toBe("/home/project (1)");
  });

  test("nested path preserved", () => {
    expect(bumpName("/a/b/c/file.log")).toBe("/a/b/c/file (1).log");
  });

  test("spaces in filename preserved", () => {
    expect(bumpName("/x/my photo.jpg")).toBe("/x/my photo (1).jpg");
    expect(bumpName("/x/my photo (1).jpg")).toBe("/x/my photo (2).jpg");
  });

  test("parens-like content that is NOT a suffix", () => {
    // " (abc).txt" 는 숫자가 아니라 숫자 match 실패 → (1) 뒤에 붙음.
    expect(bumpName("/x/foo (abc).txt")).toBe("/x/foo (abc) (1).txt");
  });

  test("empty suffix like '()' is not matched", () => {
    expect(bumpName("/x/foo ().txt")).toBe("/x/foo () (1).txt");
  });
});

describe("joinPath", () => {
  test("appends a slash when base has none", () => {
    expect(joinPath("/home", "foo.txt")).toBe("/home/foo.txt");
  });

  test("does not double the slash when base ends with /", () => {
    expect(joinPath("/home/", "foo.txt")).toBe("/home/foo.txt");
  });

  test("root base", () => {
    expect(joinPath("/", "foo")).toBe("/foo");
  });
});
