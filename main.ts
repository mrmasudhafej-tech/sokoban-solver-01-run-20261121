// Room-wise push-optimal Sokoban solver.
//
// Idea: a generated level is a hallway with independent rooms off it, and a box
// pushed out of a room can never come back, so each room is solved on its own
// and the rooms' push counts add up to the level optimum. Inside one room the
// search is breadth-first over pushes (not steps): a state is the boxes plus
// the region the player can reach, the first solved state found is therefore
// push-optimal, and two prunings keep the search small -- a box may only be
// pushed onto a square from which some goal is still reachable by pulling it
// backwards, and a 2x2 block of walls and boxes holding a box off its goal is
// frozen forever. The whole run is budgeted by states expanded, never by the
// clock, so two runs write identical bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Directions in fixed order: up, down, left, right. */
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const STEP = ['u', 'd', 'l', 'r'];
const PUSH = ['U', 'D', 'L', 'R'];

/** States one room search may keep before it gives up (the generator's own budget). */
const ROOM_STATE_LIMIT = 250_000;
/** States the whole-level fallback may keep before it gives up. */
const WHOLE_STATE_LIMIT = 200_000;
/** States the whole run may spend across all five levels: a work budget, not a clock. */
const TOTAL_STATE_LIMIT = 2_000_000;

interface Board {
  /** Padded width: the level plus a one-square wall border, so neighbours never leave the array. */
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  goalSet: Uint8Array;
  boxes: number[];
  player: number;
}

interface Solution {
  pushes: number;
  moves: string;
}

/** Shared work budget for the run. */
const budget = { used: 0 };

/** Parse XSB text into a board padded with a wall border. Short rows pad as walls. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const W = w + 2;
  const H = h + 2;
  const wall = new Uint8Array(W * H).fill(1);
  const goalSet = new Uint8Array(W * H);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 1 * W + 1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = (y + 1) * W + (x + 1);
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') {
        goalSet[i] = 1;
        goals.push(i);
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w: W, h: H, wall, goals, goalSet, boxes, player };
}

/**
 * Live squares: every square a box standing there could still be pushed onto
 * some goal. Found by pulling backwards from the goals: a square is live when
 * a box on it can be pulled from a live square while the player stands on the
 * far side. Any box off a live square is dead, and any push onto a dead square
 * is pruned.
 */
function liveSquares(board: Board): Uint8Array {
  const { w, wall, goals } = board;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (let k = 0; k < 4; k++) {
      const d = DY[k]! * w + DX[k]!;
      const from = x - d; // the square the box is pulled from
      const stand = from - d; // where the player must stand to pull it
      if (!wall[from] && !wall[stand] && !live[from]) {
        live[from] = 1;
        queue.push(from);
      }
    }
  }
  return live;
}

/**
 * Flood-fill the squares the player reaches from `from` around walls and
 * `occupied` boxes, marking them in `seen` with `stamp`. Returns the lowest
 * reached square, which names the region: two states with the same boxes and
 * the same lowest reachable square are the same state, wherever the player
 * happens to stand inside the region. The start square itself is always
 * entered, even when the caller walled it off (a finished room's goal).
 */
function flood(
  board: Board,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = board;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k]! * w + DX[k]!;
      if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed onto `t` is caught in a frozen 2x2 block. */
function frozenBlock(board: Board, occupied: Uint8Array, t: number): boolean {
  const { w, wall, goalSet } = board;
  const tx = t % w;
  const ty = Math.floor(t / w);
  for (let oy = ty - 1; oy <= ty; oy++) {
    for (let ox = tx - 1; ox <= tx; ox++) {
      const a = oy * w + ox;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      const blocked = (i: number): boolean => wall[i] === 1 || occupied[i] === 1;
      if (!blocked(a) || !blocked(b) || !blocked(c) || !blocked(d)) continue;
      for (const i of [a, b, c, d]) {
        if (occupied[i] && !goalSet[i]) return true;
      }
    }
  }
  return false;
}

/** Shortest walk from `from` to `to` around walls and boxes, lower-case steps. */
function walkTo(board: Board, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const { w, wall } = board;
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k]! * w + DX[k]!;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = STEP[k]!;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** Advance the player's square along a move string. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const k = 'udlrUDLR'.indexOf(ch) % 4;
    p += DY[k]! * w + DX[k]!;
  }
  return p;
}

/**
 * Push-optimal solution of one board by breadth-first search over pushes, or
 * null when the state limit (this call's, or the run's shared budget) runs out
 * or the board is unsolvable. States are visited once, keyed by the region's
 * lowest square plus the sorted box squares, encoded as characters.
 */
function solvePushes(board: Board, stateLimit: number): Solution | null {
  const { w, wall, goals, goalSet } = board;
  const size = wall.length;
  const live = liveSquares(board);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goalSet[b] === 1);
  if (board.boxes.some((b) => !live[b])) return null;
  if (solved(board.boxes)) return { pushes: 0, moves: '' };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const stateBoxes: number[][] = [board.boxes];
  const statePlayer: number[] = [board.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushDir: number[] = [-1];
  const keyOf = (boxes: number[], low: number): string =>
    String.fromCharCode(low, ...boxes);
  const seenKeys = new Map<string, number>();
  for (const b of board.boxes) occupied[b] = 1;
  seenKeys.set(
    keyOf(board.boxes, flood(board, occupied, board.player, seen, ++stamp, stack)),
    0,
  );
  for (const b of board.boxes) occupied[b] = 0;

  let found = -1;
  for (let head = 0; found < 0 && head < stateBoxes.length; head++) {
    const boxes = stateBoxes[head]!;
    for (const b of boxes) occupied[b] = 1;
    const regionStamp = ++stamp;
    flood(board, occupied, statePlayer[head]!, seen, regionStamp, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const from = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const d = DY[k]! * w + DX[k]!;
        const dest = from + d;
        const stand = from - d;
        if (seen[stand] !== regionStamp || wall[dest] || occupied[dest] || !live[dest]) {
          continue;
        }
        occupied[from] = 0;
        occupied[dest] = 1;
        const frozen = frozenBlock(board, occupied, dest);
        let key = '';
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = dest;
          next.sort((a, b) => a - b);
          key = keyOf(
            next,
            flood(board, occupied, from, mark, ++stamp, stack),
          );
        }
        occupied[dest] = 0;
        occupied[from] = 1;
        if (frozen || seenKeys.has(key)) continue;
        if (stateBoxes.length >= stateLimit || budget.used >= TOTAL_STATE_LIMIT) {
          for (const b of boxes) occupied[b] = 0;
          return null;
        }
        budget.used++;
        seenKeys.set(key, stateBoxes.length);
        stateBoxes.push(next!);
        statePlayer.push(from);
        parent.push(head);
        pushFrom.push(from);
        pushDir.push(k);
        if (solved(next!)) {
          found = stateBoxes.length - 1;
          break;
        }
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // Rebuild the push path, then spell it as walks plus pushes.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = board.player;
  let boxes = board.boxes;
  for (const s of path) {
    const nextBoxes = stateBoxes[s]!;
    const from = pushFrom[s]!;
    const k = pushDir[s]!;
    const d = DY[k]! * w + DX[k]!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(board, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += PUSH[k]!;
    player = from;
    boxes = nextBoxes;
  }
  void goals;
  return { pushes: path.length, moves };
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * Split a level into rooms: cut the hallway row's dead squares (squares a box
 * there could never leave for a goal) out of the floor; each remaining part
 * holding boxes is a room. Null when the level is no set of rooms: a box
 * starts in the hallway, a goal lies in the cut, or a part's boxes and goals
 * do not match.
 */
function roomsOf(board: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = board;
  const live = liveSquares(board);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k]! * w + DX[k]!;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Solve a level room by room: each room on its own board, where the other
 * rooms' boxes (or, once finished, their goals) stand as walls and the player
 * walks on from where the last room left them. Falls back to solving the
 * whole level at once when the level is no set of rooms or a room search
 * gives up.
 */
function solveLevel(board: Board): Solution | null {
  const rooms = roomsOf(board);
  if (rooms !== null) {
    let player = board.player;
    let pushes = 0;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const wall = board.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const sq of other.done ? other.goals : other.boxes) wall[sq] = 1;
      }
      const sub: Board = {
        w: board.w,
        h: board.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        goalSet: board.goalSet,
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      // The sub-board's own goal set: only this room's goals count as goals.
      const subGoalSet = new Uint8Array(board.wall.length);
      for (const g of sub.goals) subGoalSet[g] = 1;
      sub.goalSet = subGoalSet;
      const solved = solvePushes(sub, ROOM_STATE_LIMIT);
      if (solved === null) {
        ok = false;
        break;
      }
      pushes += solved.pushes;
      moves += solved.moves;
      player = endOf(board.w, player, solved.moves);
      room.done = true;
    }
    if (ok) return { pushes, moves };
  }
  return solvePushes(board, WHOLE_STATE_LIMIT);
}

/** Solve one level's text; an empty answer on any failure, so the format always holds. */
function solve(text: string): string {
  try {
    const solved = solveLevel(parseLevel(text));
    return solved === null ? '' : solved.moves;
  } catch {
    return '';
  }
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solve(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
