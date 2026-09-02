/**
 * 비밀번호 프롬프트 픽커의 재트리거 가드.
 *
 * 감지 함수는 출력이 flush 될 때마다 호출되므로, 하나의 프롬프트가 여러 번
 * 연속 발화하지 않도록 막아야 한다. key 는 `${커서 절대행}:${줄내용}` 이다.
 *
 * 문제: xterm 의 절대행(cursorY + baseY)은 스크롤백이 가득 차면 baseY 가
 * 최댓값에 고정돼 더 이상 증가하지 않는다. 그러면 서로 다른 시점에 뜬 동일
 * 텍스트의 비번 프롬프트가 완전히 같은 key 를 갖게 되어, 단순 비교 가드로는
 * 두 번째 프롬프트를 영영 못 띄운다("password 감시 풀림" 버그).
 *
 * 해결: 줄바꿈(onLineFeed)마다 `reset()` 을 호출한다. 새 프롬프트는 반드시
 * 줄바꿈을 동반하므로 key 가 같아도 다시 트리거되고, 같은 프롬프트 내(줄바꿈
 * 없음) 중복 발화는 계속 차단된다.
 *
 * `isSameAsLast` 는 상태를 바꾸지 않고 조회만 한다. 실제 트리거가 일어난
 * 시점(=매칭된 규칙 발견)에만 `markTriggered` 로 key 를 확정한다 — 원래 로직과
 * 동일하게, 규칙에 매칭되지 않은 줄은 마지막 트리거 key 를 덮어쓰지 않는다.
 */
export interface PromptTriggerGuard {
  /** 마지막으로 트리거된 key 와 동일한지(=중복 발화인지) 조회. 상태 불변. */
  isSameAsLast(key: string): boolean;
  /** 이 key 로 실제 트리거가 일어났음을 확정. */
  markTriggered(key: string): void;
  /** 가드 초기화 — 줄바꿈 시 호출해 다음 프롬프트를 다시 감지 가능하게 한다. */
  reset(): void;
}

export function createPromptTriggerGuard(): PromptTriggerGuard {
  let last: string | null = null;
  return {
    isSameAsLast(key: string): boolean {
      return key === last;
    },
    markTriggered(key: string): void {
      last = key;
    },
    reset(): void {
      last = null;
    },
  };
}
