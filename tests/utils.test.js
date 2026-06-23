import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  formatDate,
  clampNumber,
  normalizeContextValue,
  normalizeSourceLinkValue,
  selectPreferredSyncBook,
} from "../lib/utils.js";

describe("escapeHtml", () => {
  it("转义 HTML 特殊字符", () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;"
    );
  });

  it("对空值返回空字符串", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml("")).toBe("");
  });

  it("将非字符串转换为字符串", () => {
    expect(escapeHtml(123)).toBe("123");
  });
});

describe("clampNumber", () => {
  it("在区间内返回原值", () => {
    expect(clampNumber(150, 100, 1500, 100)).toBe(150);
  });

  it("低于下限时返回下限", () => {
    expect(clampNumber(50, 100, 1500, 100)).toBe(100);
  });

  it("高于上限时返回上限", () => {
    expect(clampNumber(2000, 100, 1500, 100)).toBe(1500);
  });

  it("非数字时返回兜底值", () => {
    expect(clampNumber("abc", 100, 1500, 100)).toBe(100);
    expect(clampNumber(NaN, 100, 1500, 200)).toBe(200);
  });
});

describe("formatDate", () => {
  it("空值返回未知", () => {
    expect(formatDate(0)).toBe("未知");
    expect(formatDate(null)).toBe("未知");
  });

  it("无效时间返回未知", () => {
    expect(formatDate("not-a-date")).toBe("未知");
    expect(formatDate({})).toBe("未知");
  });

  it("有效时间戳返回非未知字符串", () => {
    const result = formatDate(Date.UTC(2024, 0, 1, 12, 0, 0));
    expect(result).not.toBe("未知");
    expect(typeof result).toBe("string");
  });
});

describe("normalizeContextValue", () => {
  it("折叠空白并去除首尾空格", () => {
    expect(normalizeContextValue("  hello   world  ")).toBe("hello world");
  });

  it("空值返回空字符串", () => {
    expect(normalizeContextValue(null)).toBe("");
  });
});

describe("normalizeSourceLinkValue", () => {
  it("优先取 sourceLink", () => {
    expect(normalizeSourceLinkValue({ sourceLink: " a ", source_url: "b" })).toBe("a");
  });

  it("回退到其它字段命名", () => {
    expect(normalizeSourceLinkValue({ source_link: "x" })).toBe("x");
    expect(normalizeSourceLinkValue({ sourceUrl: "y" })).toBe("y");
    expect(normalizeSourceLinkValue({ source_url: "z" })).toBe("z");
  });

  it("无字段返回空字符串", () => {
    expect(normalizeSourceLinkValue({})).toBe("");
    expect(normalizeSourceLinkValue(null)).toBe("");
  });
});

describe("selectPreferredSyncBook", () => {
  it("无同步单词本时返回 null", () => {
    expect(selectPreferredSyncBook([{ isSync: false }])).toBeNull();
    expect(selectPreferredSyncBook([])).toBeNull();
  });

  it("仅选取 isSync 的单词本", () => {
    const books = [
      { name: "A", isSync: false },
      { name: "B", isSync: true, updatedAt: 100 },
    ];
    expect(selectPreferredSyncBook(books).name).toBe("B");
  });

  it("非默认单词本优先于默认单词本", () => {
    const books = [
      { name: "默认", isSync: true, updatedAt: 999 },
      { name: "自定义", isSync: true, updatedAt: 1 },
    ];
    expect(selectPreferredSyncBook(books).name).toBe("自定义");
  });

  it("同为非默认时取更新时间最新的", () => {
    const books = [
      { name: "Old", isSync: true, updatedAt: 100 },
      { name: "New", isSync: true, updatedAt: 200 },
    ];
    expect(selectPreferredSyncBook(books).name).toBe("New");
  });
});
