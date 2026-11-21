# Sokoban solver — room-wise push-optimal search

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/competitions/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/mrmasudhafej-tech/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/competitions/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/mrmasudhafej-tech/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/competitions/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver written for the
[sokoban-solver-01-run-20261121](https://make.fun/competitions/sokoban-solver-01-run-20261121)
bounty. `main.ts` runs as `node /bot/main.ts` on Node 22: it reads every
instance from `/input/<id>/level.txt` and writes `/output/<id>/solution.txt`,
the player's moves in LURD, in one run.

## How it works

A generated level is a hallway with independent rooms off it, and a box
pushed out of a room can never be pushed back — so each room is solved on its
own and the rooms' push counts add up to the level's push optimum. The
solver:

1. **Splits the level into rooms** by cutting the hallway row's dead squares
   (squares a box there could never leave for a goal) out of the floor; each
   remaining part holding boxes is a room.
2. **Searches each room breadth-first over pushes**, not steps. A state is the
   boxes plus the region the player can reach (named by its lowest square),
   so the first solved state found uses the fewest pushes possible.
3. **Prunes dead positions**: a box may only be pushed onto a live square
   (one from which pulling backwards reaches a goal), and a 2x2 block of
   walls and boxes holding a box off its goal is frozen forever.
4. **Spells the push path as walks plus pushes**, with a shortest walk to
   each push square, and walks on from room to room with the other rooms'
   boxes (or finished goals) standing as walls.

If a level is no set of rooms, or a room search gives up, the solver falls
back to the same push search over the whole level. The run is budgeted by
states expanded, never by the wall clock, so two runs write identical bytes.

## Local results

- Practice set: **1,000,000 / 1,000,000** — all 5 instances solved in their
  push-optimal counts (13, 16, 29, 47, 60 pushes), in ~0.9 s for the whole set.
- 50 further instances drawn fresh from the kit's own generator (10 new sets):
  all 50 solved push-optimally, each set under ~1.1 s.
