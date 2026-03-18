# MUD Parser Patterns — Common Engine Reference

When setting up for a specific MUD, identify the engine type and use these regex patterns.
Always ask the user to paste 10-20 lines of raw output to verify and tune patterns.

---

## How to Identify the MUD Engine

Look for these clues in initial connection banner:
- "ROM 2.4" or "ROM 2.4b6" → ROM (Rivers of MUD)
- "CircleMUD" / "DikuMUD" → Circle/Diku
- "LPMud" / "MudOS" / "FluffOS" → LPMud family
- "MUSH" / "MUX" / "MOO" → Social/world-building (very different gameplay)
- "Merc" / "Envy" → Merc/Envy derivative
- "Smaug" → SMAUG

---

## ROM / Merc / Envy

Very common, widely deployed.

```javascript
// Prompt: < 120hp 65mp 10mv >
const prompt = line.match(/<\s*(\d+)hp\s+(\d+)mp\s+(\d+)mv\s*>/i);
// hp=1, mp=2, mv=3

// Room name: printed as first line with no indentation, ends before blank line
// Description: follows room name, indented or plain

// Exits: [Exits: north east down]
const exits = line.match(/\[Exits?:\s*([^\]]+)\]/i);

// Combat:
// "You hit the goblin for 12 damage."
// "The goblin hits you for 8 damage."
// "You kill the goblin!"
const killLine = /you (slay|kill)/i;
const youHit   = /you (hit|pierce|slash|bash)/i;
const theyHit  = /^(\w[\w ]+) (hits?|slashes?|bashes?) you/i;
```

---

## CircleMUD / DikuMUD

```javascript
// Prompt: 100H 50M 100V >
const prompt = line.match(/(\d+)H\s+(\d+)M\s+(\d+)V/);

// Or: [100/100H 50/50M 100/100V]
const promptFull = line.match(/\[(\d+)\/(\d+)H\s+(\d+)\/(\d+)M/);

// Exits: [ Exits: N S E W U ]
const exits = line.match(/\[\s*Exits?:\s*([NSEWUD\s]+)\]/i);
// Parse individual: N=north, S=south, E=east, W=west, U=up, D=down

// Room name: preceded and followed by blank line, no period at end
// Gold: "You receive 50 gold coins."
const gold = line.match(/you receive (\d+) gold/i);
```

---

## LPMud / MudOS / FluffOS

More variable — look at sample output to identify patterns.

```javascript
// HP line varies wildly. Common:
// "HP: 100/100  SP: 50/50  EP: 80/80"
const hp = line.match(/HP:\s*(\d+)\/(\d+)/i);
const sp = line.match(/SP:\s*(\d+)\/(\d+)/i); // SP = spell points

// Exits often listed like:
// "Obvious exits: north, south, [east]"  ([] = door)
const exits = line.match(/obvious exits?:\s*(.+)/i);

// Item descriptions often end with "(lit)", "(magic)", "(worn)" etc.
```

---

## Generic Fallback Patterns

Use these when engine is unknown:

```javascript
// Any HP-like numbers
const anyHP = line.match(/(?:hp|health|hits?)\s*[:\(]?\s*(\d+)\s*[\/\-]\s*(\d+)/i);

// Direction words as exits
const dirWords = /\b(north|south|east|west|up|down|northeast|northwest|southeast|southwest|ne|nw|se|sw|in|out)\b/gi;

// Item pickup/drop
const pickup = /you (pick up|get|take|grab)\s+(.+)/i;
const drop   = /you drop\s+(.+)/i;

// Currency
const money = /(\d+)\s*(gold|silver|copper|coins?|gp|credits?)/i;

// Level up
const levelUp = /you (?:are now|gain a|go up a) level|congratulations.*level/i;

// Death
const death = /you (?:are dead|have died|fade|pass out)|you die\b|\*{3}\s*dead\s*\*{3}/i;
```

---

## Tuning Workflow

When user pastes raw output:

1. Identify the HP/prompt line pattern first — this is the most critical
2. Find where room names appear (usually first non-blank line after movement)
3. Find exit format
4. Test patterns against the sample
5. Update the regex in `scripts/mud-daemon.js` trigger/parse section

Example tuning session:

```
User pastes:
  The Town Square
  You stand in the bustling town square.
  [Exits: north south east west]
  < 85hp 42mp 100mv >

→ Room name: /^([A-Z][^\n]{3,50})$/ (first capitalized line)
→ Exits: /\[Exits?:\s*([^\]]+)\]/i  ✓ (matches ROM pattern)  
→ HP: /<\s*(\d+)hp\s+(\d+)mp\s+(\d+)mv\s*>/i  ✓ (ROM prompt)
```
