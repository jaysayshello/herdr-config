// Space avatars: one wizard per space, picked at random when the space first shows up and
// kept by space id in shared "space.wizards". Sprites: Dungeon Crawl Stone Soup tiles (CC0),
// see wizards/LICENSE.txt. Each is the hat and head of a 32x32 tile, saved 8x as wizards/NNN.png.
export const WIZARDS = 118;

export const wizard = (n) => `mods/t3-spaces/wizards/${String(n).padStart(3, "0")}.png`;

// A random wizard among the ones fewest spaces have, so spaces rarely share one.
export function pickWizard(taken) {
  const uses = (n) => taken.filter((v) => v === n).length;
  const all = Array.from({ length: WIZARDS }, (_, n) => n);
  const least = Math.min(...all.map(uses));
  const pool = all.filter((n) => uses(n) === least);
  return pool[Math.floor(Math.random() * pool.length)];
}
