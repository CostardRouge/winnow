// Limiteur de débit « goutte-à-goutte » partagé (Redis), pour répartir un
// quota horaire de manière régulière dans le temps. Atomique via un script Lua
// pour rester correct même avec plusieurs workers concurrents.
//
// Principe : pour `perHour` opérations/heure, on impose un intervalle minimal
// `3_600_000 / perHour` ms entre deux opérations. La clé Redis stocke l'horodatage
// du prochain créneau libre. reserveSlot() renvoie 0 si un créneau est dispo
// *maintenant* (et le réserve), sinon le nombre de ms à attendre (sans réserver).
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
  if (!perHour || perHour <= 0) return 0; // illimité
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
