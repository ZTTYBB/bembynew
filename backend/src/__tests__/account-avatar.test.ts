const {
  mockGetMe,
  mockConnect,
  mockDestroy,
  mockDownloadProfilePhoto,
  MockTelegramClient,
} = vi.hoisted(() => {
  const mockGetMe = vi.fn();
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  const mockDestroy = vi.fn().mockResolvedValue(undefined);
  const mockDownloadProfilePhoto = vi.fn();
  const MockTelegramClient = vi.fn().mockReturnValue({
    connect: mockConnect,
    getMe: mockGetMe,
    downloadProfilePhoto: mockDownloadProfilePhoto,
    destroy: mockDestroy,
  });
  return {
    mockGetMe,
    mockConnect,
    mockDestroy,
    mockDownloadProfilePhoto,
    MockTelegramClient,
  };
});

vi.mock("telegram", () => ({
  TelegramClient: MockTelegramClient,
  Api: {},
  Logger: vi.fn().mockReturnValue({}),
}));
vi.mock("telegram/extensions/Logger", () => ({ LogLevel: { NONE: 0 } }));
vi.mock("telegram/sessions", () => ({ StringSession: vi.fn().mockReturnValue({}) }));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkAccountStatus } from "../auth/tgAuth";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMe.mockResolvedValue({
    id: 9007199254740993n,
    firstName: "Alice",
    deleted: false,
    restricted: false,
    restrictionReason: [],
  });
});

describe("checkAccountStatus avatar collection", () => {
  it("does not download a photo when avatar collection is disabled", async () => {
    const result = await checkAccountStatus(1, "hash", "session");

    expect(result.avatar).toBeUndefined();
    expect(mockDownloadProfilePhoto).not.toHaveBeenCalled();
  });

  it("uses the already-connected client and returns a bounded data URI", async () => {
    mockDownloadProfilePhoto.mockResolvedValue(Buffer.from("avatar-bytes"));

    const result = await checkAccountStatus(1, "hash", "session", undefined, undefined, true);

    expect(mockDownloadProfilePhoto).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "Alice" }),
      { isBig: false },
    );
    expect(result.avatar).toBe(
      `data:image/jpeg;base64,${Buffer.from("avatar-bytes").toString("base64")}`,
    );
    expect(MockTelegramClient).toHaveBeenCalledTimes(1);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it("treats a photo download failure as a best-effort miss", async () => {
    mockDownloadProfilePhoto.mockRejectedValue(new Error("PHOTO_DC_UNAVAILABLE"));

    const result = await checkAccountStatus(1, "hash", "session", undefined, undefined, true);

    expect(result.isActive).toBe(true);
    expect(result.avatar).toBeUndefined();
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });
});
