// Shared "drip-feed" rate limiter (Redis), to spread an
// hourly quota evenly over time. Atomic via a Lua script
// so it stays correct even with several concurrent workers.
//
// Principle: for `perHour` operations/hour, we impose a minimum interval of
// `3_600_000 / perHour` ms between two operations. The Redis key stores the timestamp
// of the next free slot. reserveSlot() returns 0 if a slot is available
// *now* (and reserves it), otherwise the number of ms to wait (without reserving).
import { redisClient } from "./queue";

const RESERVE = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local next = tonumber(redis.call('get', key) or '0')
if now >= next then
  redis.call('set', key, now + interval, 'PX', math.max(interval * 2, 60000))
  return 0
else
  return next - now
end
`;

export async function reserveSlot(
  name: string,
  perHour: number,
): Promise<number> {
  if (!perHour || perHour <= 0) return 0; // unlimited
  const interval = Math.max(1, Math.floor(3_600_000 / perHour));
  const res = await redisClient.eval(
    RESERVE,
    1,
    `winnow:rate:${name}`,
    Date.now().toString(),
    interval.toString(),
  );
  return Number(res) || 0;
}

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));
