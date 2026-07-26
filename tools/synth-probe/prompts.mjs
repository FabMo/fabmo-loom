// Synthetic persona-anchored prompt set for the Loom decline probe.
// Each entry carries a PRIOR — what I predict the intent layer does —
// so the run also measures where my self-model is wrong.
//
// prior: 'covered' = fulfilled and verifies
//        'decline' = honestly declined (in whole or the load-bearing part)
//        'unsure'  = genuinely don't know — the interesting rows

export const PROMPTS = [
  // ---- sign makers ----
  { id: 'house-number-arrow', persona: 'homeowner', prior: 'covered',
    prompt: "A house number sign that says 4512, numbers about 5 inches tall, and shape the board like an arrow pointing left toward our driveway" },
  { id: 'open-closed-flip', persona: 'shop owner', prior: 'decline',
    prompt: "An open/closed sign for my shop door — engrave OPEN on one side and CLOSED on the other side of the same board" },
  { id: 'rustic-font', persona: 'lake house owner', prior: 'decline',
    prompt: "A cedar sign with 'Loon Lodge' carved in a rustic hand-lettered font, something like Papyrus" },
  { id: 'ada-restroom', persona: 'facilities manager', prior: 'covered',
    prompt: "An ADA all-gender restroom sign, 6 by 9 inches, with the symbol, the words, and braille underneath" },
  { id: 'curved-text-arc', persona: 'family gift maker', prior: 'decline',
    prompt: "A round family sign with 'The Hendersons' curved along the top edge and 'est. 2019' curved along the bottom" },

  // ---- hobbyist woodworker / gifts ----
  { id: 'wedding-batch-list', persona: 'wedding DIYer', prior: 'decline',
    prompt: "Leaf-shaped place cards for my daughter's wedding, each engraved with a guest's name — there are 120 guests, can I give you the list so it cuts them all?" },
  { id: 'juice-groove', persona: 'cutting board maker', prior: 'unsure',
    prompt: "A cutting board 18 by 12 with rounded corners and a juice groove running around the edge about an inch in from the border" },
  { id: 'heart-names', persona: 'parent', prior: 'covered',
    prompt: "A heart-shaped tag with my kids' names Ella and Sam engraved inside it" },
  { id: 'serving-tray', persona: 'gift maker', prior: 'unsure',
    prompt: "A serving tray — recess the whole interior half an inch deep leaving a 1 inch rim, and cut a hand-hole in each end so you can carry it" },
  { id: 'monogram-inlay', persona: 'anniversary gift', prior: 'decline',
    prompt: "I want to inlay my wife's initials KJM in walnut into a maple board — cut the pocket and the matching plug" },

  // ---- kitchen / home ----
  { id: 'hex-trivet', persona: 'housewares maker', prior: 'unsure',
    prompt: "A trivet made of a honeycomb pattern — hexagons with gaps between them so the hot pan sits on the honeycomb" },
  { id: 'clock-face', persona: 'clock builder', prior: 'covered',
    prompt: "A 10 inch round clock face: a hole in the center for the mechanism, 12 hour marks drilled evenly around the edge, and the number 12 engraved at the top" },
  { id: 'chess-board', persona: 'game maker', prior: 'unsure',
    prompt: "A chess board — 8 by 8 grid of 2 inch squares, pocket the dark squares a sixteenth deep so I can epoxy them" },
  { id: 'ruler-ticks', persona: 'workshop organizer', prior: 'unsure',
    prompt: "Engrave a 12 inch ruler along the edge of the board with tick marks every quarter inch, longer ticks on the inches" },

  // ---- cosplay / props ----
  { id: 'pepakura-file', persona: 'cosplayer', prior: 'decline',
    prompt: "I have a Pepakura PDO file of a Mandalorian chest plate — cut the pieces from EVA foam" },
  { id: 'pinterest-sword', persona: 'prop maker', prior: 'decline',
    prompt: "Cut a sword blank from a picture of a katana I found on Pinterest — I can send you the JPG" },

  // ---- school shop ----
  { id: 'catapult-kits', persona: 'shop teacher', prior: 'unsure',
    prompt: "I teach middle school shop. I need 20 identical catapult kits — a base, two arms, and a crossbar each — nested onto as few 2x4 foot sheets as possible" },
  { id: 'finger-joint-box', persona: 'shop teacher', prior: 'unsure',
    prompt: "A small box with finger joints, 6 by 4 by 3 inches, that snaps together from quarter inch plywood" },

  // ---- luthier / precision ----
  { id: 'guitar-dxf', persona: 'luthier', prior: 'decline',
    prompt: "Cut a telecaster body from my DXF file" },
  { id: 'fret-slots', persona: 'luthier', prior: 'decline',
    prompt: "Slot a fretboard for a 25.5 inch scale, 22 frets — the slots need to be .023 wide and .095 deep at the right positions" },

  // ---- speaker / electronics ----
  { id: 'speaker-baffle', persona: 'audio DIYer', prior: 'unsure',
    prompt: "A speaker baffle: two 6.5 inch driver cutouts with a recessed flange an eighth deep so the drivers sit flush, plus a 2 inch port hole, board is 8 by 20" },
  { id: 'pcb-standoffs', persona: 'electronics hobbyist', prior: 'unsure',
    prompt: "An enclosure bottom for my Raspberry Pi with four standoff bosses that stick up a quarter inch where the mounting holes are" },

  // ---- van / RV ----
  { id: 'finger-pull-doors', persona: 'van builder', prior: 'unsure',
    prompt: "Cabinet doors for my van build — 14 by 10 with a routed finger pull scooped into the bottom edge instead of a handle" },

  // ---- terrain ----
  { id: 'tahoe-bathymetry', persona: 'lake lover', prior: 'unsure',
    prompt: "A carving of Lake Tahoe showing the underwater depth — the bathymetry, not just the shoreline" },
  { id: 'ski-runs-overlay', persona: 'ski house', prior: 'decline',
    prompt: "A terrain carving of Jackson Hole with the ski runs engraved as lines on the mountain faces" },
  { id: 'terrain-classic', persona: 'park fan', prior: 'covered',
    prompt: "A relief carving of Yosemite Valley about 12 inches wide with the name on a plaque in the corner" },

  // ---- furniture ----
  { id: 'bookshelf', persona: 'apartment dweller', prior: 'covered',
    prompt: "A simple bookshelf, 30 inches wide, 36 tall, three shelves, from three quarter ply" },
  { id: 'adirondack', persona: 'deck owner', prior: 'unsure',
    prompt: "An adirondack chair with the classic curved seat slats and fanned back" },
  { id: 'round-stool', persona: 'kitchen', prior: 'unsure',
    prompt: "A round-seat stool with three legs splayed out at an angle for stability" },
  { id: 'name-on-bench', persona: 'grandparent', prior: 'covered',
    prompt: "A kids bench with EMMA carved into the seat" },

  // ---- 3D / files ----
  { id: 'stl-dog-bone', persona: 'pet owner', prior: 'decline',
    prompt: "Carve this dog bone STL I downloaded from Thingiverse" },
  { id: 'photo-memorial', persona: 'memorial gift', prior: 'decline',
    prompt: "A memorial plaque for my dad with his photo etched into the wood above the dates 1948-2025" },

  // ---- text effects ----
  { id: 'mirror-text', persona: 'sign maker', prior: 'decline',
    prompt: "Mirror the text so I can machine it from the back of an acrylic panel" },
  { id: 'raised-letters', persona: 'sign maker', prior: 'covered',
    prompt: "I want the letters raised, not engraved — carve the background away so WELCOME stands up proud of the surface" },
  { id: 'vertical-text', persona: 'sign maker', prior: 'decline',
    prompt: "A vertical sign like an old hotel marquee — H O T E L reading top to bottom, one letter above the next" },

  // ---- practical CNC ----
  { id: 'roundover-regression', persona: 'anyone', prior: 'decline',
    prompt: "A round sign with 'BAKERY' engraved, and round over the top edge so it's not sharp" },
  { id: 'dogbone-corners', persona: 'furniture DIYer', prior: 'unsure',
    prompt: "A shelf bracket with a square notch that fits over a 2x4 — add dog-bone fillets in the inside corners so the lumber actually fits" },
  { id: 'angled-drilling', persona: 'joinery', prior: 'decline',
    prompt: "Drill pocket-screw holes at 15 degrees into the edge of the rails" },
  { id: 'acrylic-feeds', persona: 'new owner', prior: 'unsure',
    prompt: "A keychain tag with a name, but I'm cutting half inch acrylic — set the feeds and speeds right for acrylic so it doesn't melt" },
  { id: 'split-two-boards', persona: 'small machine', prior: 'unsure',
    prompt: "This sign is 40 inches wide but my machine only does 24 by 18 — split the design across two boards I can butt together" },

  // ---- units ----
  { id: 'metric-board', persona: 'european user', prior: 'unsure',
    prompt: "A serving board 450mm by 300mm with 8mm radius corners and a 60mm hanging hole" },

  // ---- personalization / patterns ----
  { id: 'qr-menu', persona: 'restaurant owner', prior: 'decline',
    prompt: "A table tent with a QR code pocketed into it that links to https://mario-pizza.example/menu" },
  { id: 'cribbage', persona: 'game maker', prior: 'unsure',
    prompt: "A cribbage board — three tracks of 120 holes each following the classic S curve, plus a skunk line" },
  { id: 'catan-insert', persona: 'board gamer', prior: 'unsure',
    prompt: "A board game insert for Catan — stacked trays with pockets sized for the cards, tiles, and wooden pieces" },
  { id: 'flag-stars', persona: 'veteran gift', prior: 'unsure',
    prompt: "A wavy American flag carving with 50 stars pocketed in the union" },
  { id: 'herringbone-bg', persona: 'decor maker', prior: 'covered',
    prompt: "A plaque with LOVE engraved big, and a herringbone texture carved into the background around the letters" },

  // ---- assets ----
  { id: 'logo-no-upload', persona: 'small business', prior: 'unsure',
    prompt: "A lazy susan, 14 inch circle, ring of 8 bearing holes near the center, and put my logo in the middle" },
  { id: 'record-clock-svg', persona: 'musician', prior: 'covered', asset: 'svg',
    prompt: "A clock shaped like a vinyl record from the uploaded logo SVG — cut the disc 12 inches, spindle hole in the center, and pocket the logo across the middle" },

  // ---- rotary / out of scope ----
  { id: 'baseball-bat', persona: 'coach', prior: 'decline',
    prompt: "Turn a baseball bat on the rotary axis with my son's name engraved down the barrel" },

  // ---- refinement-flavored first asks ----
  { id: 'make-it-fit', persona: 'small machine', prior: 'unsure',
    prompt: "A welcome sign with a sunflower on it, but everything has to fit my little 12 by 12 hobby machine" },
];

// one small legit SVG for asset-bearing prompts
export const FAKE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g transform="translate(50 50)"><path fill-rule="evenodd" d="M -40 -25 L 40 -25 L 40 25 L -40 25 Z M -10 0 A 10 10 0 1 1 10 0 A 10 10 0 1 1 -10 0 Z"/></g></svg>';
