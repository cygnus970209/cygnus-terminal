import { describe, test, expect } from "vitest";
import { createPromptTriggerGuard } from "./promptTriggerGuard";

describe("createPromptTriggerGuard", () => {
  test("같은 프롬프트(같은 key) 중복 발화는 차단한다", () => {
    const g = createPromptTriggerGuard();
    const key = "42:[sudo] password for me:";
    expect(g.isSameAsLast(key)).toBe(false); // 최초 → 트리거 허용
    g.markTriggered(key);
    expect(g.isSameAsLast(key)).toBe(true); // 같은 key 재호출 → 차단
  });

  test("reset 후에는 동일 key 라도 다시 트리거된다 (스크롤백 포화 회귀)", () => {
    // 버그 재현: 스크롤백이 가득 차면 baseY 가 고정돼 cursorAbs 가 상수가 되고,
    // 동일 텍스트의 새 비번 프롬프트가 직전과 완전히 같은 key 를 갖는다.
    // reset 이 없으면 두 번째 프롬프트는 영영 안 뜬다.
    const g = createPromptTriggerGuard();
    const key = "10000:Password:"; // baseY 고정 상태의 대표 key
    g.markTriggered(key);
    expect(g.isSameAsLast(key)).toBe(true); // reset 전 → 차단(버그 상태)

    g.reset(); // onLineFeed(줄바꿈) 발생

    expect(g.isSameAsLast(key)).toBe(false); // reset 후 → 재트리거 허용(수정됨)
  });

  test("매칭 안 된 줄은 마지막 트리거 key 를 덮어쓰지 않는다", () => {
    // isSameAsLast 는 조회만 하고 상태를 바꾸지 않는다. 실제 트리거(규칙 매칭)
    // 시점에만 markTriggered 로 확정하므로, 중간의 비-프롬프트 줄이 가드를
    // 흔들지 않는다.
    const g = createPromptTriggerGuard();
    const pw = "5:Password:";
    g.markTriggered(pw);
    // 비-프롬프트 줄을 조회만 함
    expect(g.isSameAsLast("6:$ ls")).toBe(false);
    // 원래 프롬프트 key 는 여전히 마지막으로 기억됨 → 중복 차단 유지
    expect(g.isSameAsLast(pw)).toBe(true);
  });
});
