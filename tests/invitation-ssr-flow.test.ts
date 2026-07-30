import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConfirmationClient: vi.fn(),
  verifyOtp: vi.fn(),
}));

vi.mock("@/lib/supabase/confirm-server", () => ({
  createConfirmationClient: mocks.createConfirmationClient,
}));

import { GET } from "@/app/auth/confirm/route";

describe("server-confirmed invitation flow", () => {
  beforeEach(() => {
    vi.stubEnv("APP_URL", "https://alupc-attendance.vercel.app");
    mocks.verifyOtp.mockReset();
    mocks.createConfirmationClient.mockReset();
    mocks.createConfirmationClient.mockImplementation(
      (
        _request: NextRequest,
        setCookies: (
          cookies: {
            name: string;
            value: string;
            options: Record<string, unknown>;
          }[],
          headers: Record<string, string>,
        ) => void,
      ) => {
        setCookies(
          [
            {
              name: "sb-test-auth-token",
              value: "cookie-session",
              options: {
                path: "/",
                sameSite: "lax",
                secure: true,
              },
            },
          ],
          { Pragma: "no-cache" },
        );
        return { auth: { verifyOtp: mocks.verifyOtp } };
      },
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("verifies the invite token, establishes cookies, and opens setup-password", async () => {
    mocks.verifyOtp.mockResolvedValue({
      data: {
        session: {
          access_token: "access-token",
          refresh_token: "refresh-token",
        },
      },
      error: null,
    });
    const response = await GET(
      new NextRequest(
        "https://alupc-attendance-alsussexs-projects.vercel.app/auth/confirm?token_hash=invite-hash&type=invite&next=/auth/setup-password",
      ),
    );

    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      token_hash: "invite-hash",
      type: "invite",
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://alupc-attendance.vercel.app/auth/setup-password#access_token=access-token&refresh_token=refresh-token&type=invite",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "sb-test-auth-token=cookie-session",
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects invalid invitation types without verifying a token", async () => {
    const response = await GET(
      new NextRequest(
        "https://alupc-attendance.vercel.app/auth/confirm?token_hash=hash&type=recovery",
      ),
    );
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(
      "https://alupc-attendance.vercel.app/auth/setup-password?error=invalid_invitation",
    );
  });

  it("never redirects a verified invitation outside setup-password", async () => {
    mocks.verifyOtp.mockResolvedValue({
      data: {
        session: {
          access_token: "access-token",
          refresh_token: "refresh-token",
        },
      },
      error: null,
    });
    const response = await GET(
      new NextRequest(
        "https://alupc-attendance.vercel.app/auth/confirm?token_hash=hash&type=invite&next=https://malicious.example/steal",
      ),
    );
    expect(response.headers.get("location")).toContain(
      "https://alupc-attendance.vercel.app/auth/setup-password#",
    );
  });

  it("shows the setup error when Supabase rejects an expired invite", async () => {
    mocks.verifyOtp.mockResolvedValue({
      data: { session: null },
      error: { message: "Token has expired or is invalid" },
    });
    const response = await GET(
      new NextRequest(
        "https://alupc-attendance.vercel.app/auth/confirm?token_hash=expired&type=invite",
      ),
    );
    expect(response.headers.get("location")).toBe(
      "https://alupc-attendance.vercel.app/auth/setup-password?error=invalid_invitation",
    );
  });
});
