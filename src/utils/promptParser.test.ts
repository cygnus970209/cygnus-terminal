import { describe, test, expect } from "vitest";
import { extractCommand } from "./promptParser";

describe("extractCommand", () => {
  test("Amazon Linux user prompt with tilde — bug 재현 케이스", () => {
    // `[$#>%❯→\])\x1b]*\s+(.+)` 의 leftmost-zero-match 버그가 잡혔던 라인.
    // 첫 공백(prompt 중간)부터 잡혀서 group 1 이 `~]$ ls` 가 되던 회귀.
    expect(extractCommand("[ec2-user@ip-172-16-0-87 ~]$ ls")).toBe("ls");
  });

  test("Amazon Linux root prompt after sudo su", () => {
    expect(extractCommand("[root@ip-172-16-0-87 ec2-user]# exit")).toBe("exit");
  });

  test("표준 user prompt", () => {
    expect(extractCommand("alice@laptop:~/work$ git push origin main")).toBe(
      "git push origin main",
    );
  });

  test("zsh % prompt", () => {
    expect(extractCommand("% ls -la")).toBe("ls -la");
  });

  test("starship/oh-my-zsh ❯ prompt", () => {
    expect(extractCommand("❯ npm test")).toBe("npm test");
  });

  test("bash 기본 prompt", () => {
    expect(extractCommand("bash-4.2# ls")).toBe("ls");
  });

  test("명령어 안에 prompt 문자 포함 — backtracking 으로 정상 처리", () => {
    expect(extractCommand('[host ~]$ echo "test$"')).toBe('echo "test$"');
    expect(extractCommand("user@h$ echo $HOME")).toBe("echo $HOME");
  });

  test("빈 라인", () => {
    expect(extractCommand("")).toBeNull();
    expect(extractCommand("   ")).toBeNull();
  });

  test("prompt 만 있고 명령어 없는 라인", () => {
    expect(extractCommand("[ec2-user@host ~]$ ")).toBeNull();
    expect(extractCommand("$ ")).toBeNull();
  });

  test("prompt 없는 평문 라인", () => {
    expect(extractCommand("hello world")).toBeNull();
  });

  test("git continuation > prompt", () => {
    expect(extractCommand("> commit message body")).toBe("commit message body");
  });
});
