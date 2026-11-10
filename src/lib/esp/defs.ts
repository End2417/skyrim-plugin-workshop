// Field layouts for common Skyrim LE record types, based on TES5Edit's definitions.
// Anything not described here is still shown and editable as raw data.

export type IntKind = "u8" | "u16" | "u32" | "i8" | "i16" | "i32";

export type FieldDef =
  | {
      k: IntKind;
      n: string;
      enum?: Record<number, string>;
      flags?: Record<number, string>;
      hex?: boolean;
      div?: number;
    }
  | { k: "f32"; n: string }
  | { k: "fid"; n: string }
  | { k: "str"; n: string }
  | { k: "lstr"; n: string }
  | { k: "bytes"; n: string; size?: number }
  | { k: "struct"; n: string; m: FieldDef[] }
  | { k: "array"; n: string; of: FieldDef };

/** A subrecord layout, optionally chosen from the record's Editor ID or the subrecord bytes. */
export type SubDef = { label: string; def: FieldDef | ((ctx: { edid: string; data: Uint8Array }) => FieldDef) };

export interface RecordDef {
  name: string;
  flags?: Record<number, string>;
  subs: Record<string, SubDef>;
}

// ---------- builders ----------
type IntOpts = { enum?: Record<number, string>; flags?: Record<number, string> | string[]; hex?: boolean; div?: number };
const int =
  (k: IntKind) =>
  (n: string, o: IntOpts = {}): FieldDef => ({
    k,
    n,
    ...(o.enum && { enum: o.enum }),
    ...(o.flags && { flags: Array.isArray(o.flags) ? bits(o.flags) : o.flags }),
    ...(o.hex && { hex: true }),
    ...(o.div && { div: o.div }),
  });
const u8 = int("u8"), u16 = int("u16"), u32 = int("u32"), i8 = int("i8"), i16 = int("i16"), i32 = int("i32");
const f32 = (n: string): FieldDef => ({ k: "f32", n });
const fid = (n: string): FieldDef => ({ k: "fid", n });
const str = (n: string): FieldDef => ({ k: "str", n });
const lstr = (n: string): FieldDef => ({ k: "lstr", n });
const bytes = (n: string, size?: number): FieldDef => (size ? { k: "bytes", n, size } : { k: "bytes", n });
const unused = (size: number) => bytes("Unused", size);
const struct = (n: string, m: FieldDef[]): FieldDef => ({ k: "struct", n, m });
const array = (n: string, of: FieldDef): FieldDef => ({ k: "array", n, of });
const sub = (label: string, def: SubDef["def"]): SubDef => ({ label, def });
/** Flag names listed in bit order (empty strings skip a bit). */
function bits(names: string[]): Record<number, string> {
  const out: Record<number, string> = {};
  names.forEach((n, i) => n && (out[2 ** i] = n));
  return out;
}
const sparse = (pairs: [number, string][]) => Object.fromEntries(pairs.map(([b, n]) => [2 ** b, n]));
const list = (names: string[]) => Object.fromEntries(names.map((n, i) => [i, n]));

// ---------- shared enums ----------
const BOOL = list(["False", "True"]);
const SKILL: Record<number, string> = {
  [-1]: "None", 6: "One Handed", 7: "Two Handed", 8: "Archery", 9: "Block", 10: "Smithing",
  11: "Heavy Armor", 12: "Light Armor", 13: "Pickpocket", 14: "Lockpicking", 15: "Sneak",
  16: "Alchemy", 17: "Speech", 18: "Alteration", 19: "Conjuration", 20: "Destruction",
  21: "Illusion", 22: "Restoration", 23: "Enchanting",
};
const CAST = list(["Constant Effect", "Fire and Forget", "Concentration"]);
const DELIVERY = list(["Self", "Touch", "Aimed", "Target Actor", "Target Location"]);
const SOUL_GEM = list(["None", "Petty", "Lesser", "Common", "Greater", "Grand"]);
const SOUND_LEVEL = list(["Loud", "Normal", "Silent", "Very Loud"]);
const ARMOR_TYPE = list(["Light Armor", "Heavy Armor", "Clothing"]);
const BIPED_SLOTS = bits([
  "30 - Head", "31 - Hair", "32 - Body", "33 - Hands", "34 - Forearms", "35 - Amulet", "36 - Ring",
  "37 - Feet", "38 - Calves", "39 - Shield", "40 - Tail", "41 - LongHair", "42 - Circlet", "43 - Ears",
  "44 - Unnamed", "45 - Unnamed", "46 - Unnamed", "47 - Unnamed", "48 - Unnamed", "49 - Unnamed",
  "50 - DecapitateHead", "51 - Decapitate", "52 - Unnamed", "53 - Unnamed", "54 - Unnamed",
  "55 - Unnamed", "56 - Unnamed", "57 - Unnamed", "58 - Unnamed", "59 - Unnamed", "60 - Unnamed",
  "61 - FX01",
]);
const RUN_ON = list(["Subject", "Target", "Reference", "Combat Target", "Linked Reference", "Quest Alias", "Package Data", "Event Data"]);
const NON_PLAYABLE = { 0x4: "Non-Playable" };

// ---------- subrecords shared by many records ----------
const COMMON: Record<string, SubDef> = {
  EDID: sub("Editor ID", str("Editor ID")),
  FULL: sub("Name", lstr("Name")),
  DESC: sub("Description", lstr("Description")),
  OBND: sub("Object Bounds", struct("Object Bounds", [i16("X1"), i16("Y1"), i16("Z1"), i16("X2"), i16("Y2"), i16("Z2")])),
  VMAD: sub("Virtual Machine Adapter (scripts)", bytes("Script data")),
  MODL: sub("Model FileName", str("Model FileName")),
  MODT: sub("Texture Files Hashes", bytes("Hashes")),
  MODS: sub("Alternate Textures", bytes("Alternate Textures")),
  MOD2: sub("Male World Model", str("Model FileName")),
  MO2T: sub("Texture Files Hashes", bytes("Hashes")),
  MO2S: sub("Alternate Textures", bytes("Alternate Textures")),
  MOD3: sub("Model FileName", str("Model FileName")),
  MO3T: sub("Texture Files Hashes", bytes("Hashes")),
  MOD4: sub("Female World Model", str("Model FileName")),
  MO4T: sub("Texture Files Hashes", bytes("Hashes")),
  MO4S: sub("Alternate Textures", bytes("Alternate Textures")),
  ICON: sub("Inventory Image", str("FileName")),
  MICO: sub("Message Icon", str("FileName")),
  ICO2: sub("Female Inventory Image", str("FileName")),
  MIC2: sub("Female Message Icon", str("FileName")),
  KSIZ: sub("Keyword Count", u32("Count")),
  KWDA: sub("Keywords", array("Keywords", fid("Keyword"))),
  YNAM: sub("Sound - Pick Up", fid("Sound")),
  ZNAM: sub("Sound - Put Down", fid("Sound")),
  ETYP: sub("Equipment Type", fid("Equip Type")),
  EITM: sub("Object Effect", fid("Enchantment")),
  EAMT: sub("Enchantment Amount", u16("Amount")),
  DEST: sub("Destructible", struct("Header", [i32("Health"), u8("DEST Count"), u8("VATS Targetable", { enum: BOOL }), unused(2)])),
  DSTD: sub("Destruction Stage Data", bytes("Data")),
  DMDL: sub("Destruction Stage Model", str("Model FileName")),
  DMDT: sub("Texture Files Hashes", bytes("Hashes")),
  DSTF: sub("End Marker", bytes("Marker")),
  COCT: sub("Item Count", u32("Count")),
  CNTO: sub("Item", struct("Item", [fid("Item"), i32("Count")])),
  COED: sub("Extra Data", struct("Extra Data", [fid("Owner"), u32("Global Variable / Required Rank", { hex: true }), f32("Item Condition")])),
  EFID: sub("Effect - Base Effect", fid("Magic Effect")),
  EFIT: sub("Effect - Data", struct("Effect", [f32("Magnitude"), u32("Area"), u32("Duration")])),
  CTDA: sub(
    "Condition",
    struct("Condition", [
      u8("Type (operator & flags)", { hex: true }),
      unused(3),
      f32("Comparison Value"),
      u16("Function"),
      unused(2),
      u32("Parameter #1", { hex: true }),
      u32("Parameter #2", { hex: true }),
      u32("Run On", { enum: RUN_ON }),
      fid("Reference"),
      i32("Parameter #3"),
    ]),
  ),
  CIS1: sub("Condition Parameter #1", str("Text")),
  CIS2: sub("Condition Parameter #2", str("Text")),
  SPCT: sub("Spell Count", u32("Count")),
  SPLO: sub("Actor Effect", fid("Spell")),
  BODT: sub(
    "Body Template",
    struct("Body Template", [
      u32("First Person Flags", { flags: BIPED_SLOTS }),
      u8("General Flags", { flags: { 0x1: "Modulates Voice", 0x10: "Non-Playable" } }),
      unused(3),
      u32("Armor Type", { enum: ARMOR_TYPE }),
    ]),
  ),
  BOD2: sub("Biped Body Template", struct("Biped Body Template", [u32("First Person Flags", { flags: BIPED_SLOTS }), u32("Armor Type", { enum: ARMOR_TYPE })])),
  // Placed references
  NAME: sub("Base", fid("Base Object")),
  XSCL: sub("Scale", f32("Scale")),
  XESP: sub("Enable Parent", struct("Enable Parent", [fid("Reference"), u8("Flags", { flags: ["Set Enable State to Opposite of Parent", "Pop In"] }), unused(3)])),
  XOWN: sub("Owner", fid("Owner")),
  XRNK: sub("Faction Rank", i32("Rank")),
  XLCM: sub("Level Modifier", i32("Level Modifier", { enum: list(["Easy", "Medium", "Hard", "Very Hard"]) })),
  XCNT: sub("Count", i32("Count")),
  XRDS: sub("Radius", f32("Radius")),
  XHLP: sub("Health", f32("Health")),
  XLKR: sub("Linked Reference", struct("Linked Reference", [fid("Keyword/Ref"), fid("Ref")])),
  XLCN: sub("Persistent Location", fid("Location")),
  XLRL: sub("Location Reference", fid("Location")),
  XEZN: sub("Encounter Zone", fid("Encounter Zone")),
  XLRT: sub("Location Ref Type", array("Location Ref Types", fid("Ref Type"))),
  XMRC: sub("Merchant Container", fid("Container")),
  XLOC: sub("Lock Data", struct("Lock", [u8("Level"), unused(3), fid("Key"), u8("Flags", { flags: ["", "", "Leveled Lock"] }), unused(3), bytes("Unknown")])),
};

const OBJECT_DATA = sub("Data", struct("Data", [i32("Value"), f32("Weight")]));

const LEVELED = {
  LVLD: sub("Chance None", u8("Chance None")),
  LVLG: sub("Global", fid("Global")),
  LLCT: sub("Entry Count", u8("Count")),
  LVLO: sub("Leveled List Entry", struct("Entry", [u16("Level"), unused(2), fid("Reference"), u16("Count"), unused(2)])),
};

const SPELL_DATA = sub(
  "Spell Data",
  struct("Data", [
    u32("Base Cost"),
    u32("Flags", {
      flags: sparse([[0, "Manual Cost Calc"], [17, "PC Start Spell"], [19, "Area Effect Ignores LOS"], [20, "Ignore Resistance"], [21, "Disallow Absorb/Reflect"], [23, "No Dual Cast Modification"]]),
    }),
    u32("Type", { enum: { ...list(["Spell", "Disease", "Power", "Lesser Power", "Ability", "Poison"]), 10: "Addiction", 11: "Voice" } }),
    f32("Charge Time"),
    u32("Cast Type", { enum: CAST }),
    u32("Delivery", { enum: DELIVERY }),
    f32("Cast Duration"),
    f32("Range"),
    fid("Half-cost Perk"),
  ]),
);

export const COMMON_RECORD_FLAGS: Record<number, string> = {
  0x20: "Deleted",
  0x400: "Persistent",
  0x800: "Initially Disabled",
  0x1000: "Ignored",
  0x40000: "Compressed",
};

export const RECORD_DEFS: Record<string, RecordDef> = {
  TES4: {
    name: "Main File Header",
    flags: { 0x1: "ESM", 0x80: "Localized", 0x200: "ESL" },
    subs: {
      HEDR: sub("Header", struct("Header", [f32("Version"), i32("Number of Records"), u32("Next Object ID", { hex: true })])),
      CNAM: sub("Author", str("Author")),
      SNAM: sub("Description", str("Description")),
      MAST: sub("Master File", str("FileName")),
      DATA: sub("Master File Size (unused)", bytes("Unknown", 8)),
      ONAM: sub("Overridden Forms", array("Overridden Forms", fid("Form"))),
      INTV: sub("Unknown", u32("Unknown")),
      INCC: sub("Interior Cell Count", u32("Count")),
    },
  },
  GMST: {
    name: "Game Setting",
    subs: {
      DATA: sub("Value", ({ edid }) => {
        switch (edid[0]?.toLowerCase()) {
          case "s": return lstr("String");
          case "i": return i32("Int");
          case "f": return f32("Float");
          case "b": return u32("Bool", { enum: BOOL });
          default: return bytes("Value");
        }
      }),
    },
  },
  GLOB: {
    name: "Global",
    flags: { 0x40: "Constant" },
    subs: {
      FNAM: sub("Type", u8("Type", { enum: { 115: "Short", 108: "Long", 102: "Float" } })),
      FLTV: sub("Value", f32("Value")),
    },
  },
  KYWD: { name: "Keyword", subs: { CNAM: sub("Color", struct("Color", [u8("Red"), u8("Green"), u8("Blue"), u8("Alpha")])) } },
  WEAP: {
    name: "Weapon",
    flags: NON_PLAYABLE,
    subs: {
      BIDS: sub("Block Bash Impact Data Set", fid("Impact Data Set")),
      BAMT: sub("Alternate Block Material", fid("Material")),
      NNAM: sub("Embedded Weapon Node", str("Node")),
      INAM: sub("Impact Data Set", fid("Impact Data Set")),
      WNAM: sub("1st Person Model Object", fid("Static")),
      SNAM: sub("Attack Sound", fid("Sound")),
      XNAM: sub("Attack Sound 2D", fid("Sound")),
      NAM7: sub("Attack Loop Sound", fid("Sound")),
      TNAM: sub("Attack Fail Sound", fid("Sound")),
      UNAM: sub("Idle Sound", fid("Sound")),
      NAM9: sub("Equip Sound", fid("Sound")),
      NAM8: sub("Unequip Sound", fid("Sound")),
      DATA: sub("Game Data", struct("Game Data", [u32("Value"), f32("Weight"), u16("Damage")])),
      DNAM: sub(
        "Data",
        struct("Data", [
          u8("Animation Type", { enum: list(["HandToHandMelee", "OneHandSword", "OneHandDagger", "OneHandAxe", "OneHandMace", "TwoHandSword", "TwoHandAxe", "Bow", "Staff", "Crossbow"]) }),
          unused(3),
          f32("Speed"),
          f32("Reach"),
          u16("Flags", { flags: ["Ignores Normal Weapon Resistance", "Automatic (unused)", "Has Scope (unused)", "Can't Drop", "Hide Backpack (unused)", "Embedded Weapon", "Don't Use 1st Person IS Anim (unused)", "Non-playable"] }),
          unused(2),
          f32("Sight FOV"),
          bytes("Unknown", 4),
          u8("Base VATS To-Hit Chance"),
          u8("Attack Animation"),
          u8("# Projectiles"),
          u8("Embedded Weapon Actor Value"),
          f32("Range Min"),
          f32("Range Max"),
          u32("On Hit", { enum: list(["No formula behaviour", "Dismember only", "Explode only", "No dismember/explode"]) }),
          u32("Flags2", { flags: ["Player Only", "NPCs Use Ammo", "No Jam After Reload (unused)", "", "Minor Crime", "Range Fixed", "Not Used in Normal Combat", "", "Don't Use 3rd Person IS Anim (unused)", "Burst Shot", "Rumble - Alternate", "Long Bursts", "Non-hostile", "Bound Weapon"] }),
          f32("Animation Attack Mult"),
          f32("Fire Rate"),
          f32("Rumble - Left Motor Strength"),
          f32("Rumble - Right Motor Strength"),
          f32("Rumble - Duration"),
          f32("Override - Damage to Weapon Mult"),
          f32("Attack Shots/Sec"),
          bytes("Unknown", 4),
          i32("Skill", { enum: SKILL }),
          bytes("Unknown", 8),
          i32("Resist"),
          bytes("Unknown", 4),
          f32("Stagger"),
        ]),
      ),
      CRDT: sub("Critical Data", struct("Critical Data", [u16("Damage"), unused(2), f32("% Mult"), u8("On Death", { enum: BOOL }), unused(3), fid("Effect")])),
      VNAM: sub("Detection Sound Level", u32("Sound Level", { enum: SOUND_LEVEL })),
      CNAM: sub("Template", fid("Weapon")),
    },
  },
  ARMO: {
    name: "Armor",
    flags: { 0x4: "Non-Playable", 0x40: "Shield", 0x8000: "Visible When Distant" },
    subs: {
      BMCT: sub("Ragdoll Constraint Template", str("Template")),
      BIDS: sub("Bash Impact Data Set", fid("Impact Data Set")),
      BAMT: sub("Alternate Block Material", fid("Material")),
      RNAM: sub("Race", fid("Race")),
      MODL: sub("Armature (Armor Addon)", fid("Armor Addon")),
      DATA: OBJECT_DATA,
      DNAM: sub("Armor Rating", i32("Armor Rating", { div: 100 })),
      TNAM: sub("Template Armor", fid("Armor")),
    },
  },
  ARMA: {
    name: "Armor Addon",
    subs: {
      RNAM: sub("Race", fid("Race")),
      DNAM: sub("Data", struct("Data", [u8("Male Priority"), u8("Female Priority"), bytes("Weight Slider - Male", 4), bytes("Weight Slider - Female", 4), unused(2), u8("Detection Sound Value"), unused(1), f32("Weapon Adjust")])),
      MOD2: sub("Male World Model", str("Model FileName")),
      MOD3: sub("Female World Model", str("Model FileName")),
      MOD4: sub("Male 1st Person", str("Model FileName")),
      MOD5: sub("Female 1st Person", str("Model FileName")),
      NAM0: sub("Male Skin Texture", fid("Texture Set")),
      NAM1: sub("Female Skin Texture", fid("Texture Set")),
      NAM2: sub("Male Skin Texture Swap List", fid("Form List")),
      NAM3: sub("Female Skin Texture Swap List", fid("Form List")),
      MODL: sub("Additional Race", fid("Race")),
      SNDD: sub("Footstep Sound", fid("Footstep Set")),
      ONAM: sub("Art Object", fid("Art Object")),
    },
  },
  AMMO: {
    name: "Ammunition",
    flags: NON_PLAYABLE,
    subs: {
      DATA: sub("Data", struct("Data", [fid("Projectile"), u32("Flags", { flags: ["Ignores Normal Weapon Resistance", "Non-Playable", "Non-Bolt"] }), f32("Damage"), u32("Value")])),
      ONAM: sub("Short Name", str("Short Name")),
    },
  },
  BOOK: {
    name: "Book",
    subs: {
      DESC: sub("Book Text", lstr("Book Text")),
      DATA: sub("Data", ({ data }) => {
        const f = data[0] ?? 0;
        const teaches = f & 0x4 ? fid("Teaches Spell") : f & 0x1 ? i32("Teaches Skill", { enum: SKILL }) : unused(4);
        return struct("Data", [
          u8("Flags", { flags: ["Teaches Skill", "Can't be Taken", "Teaches Spell"] }),
          u8("Type", { enum: { 0: "Book/Tome", 255: "Note/Scroll" } }),
          unused(2),
          teaches,
          u32("Value"),
          f32("Weight"),
        ]);
      }),
      INAM: sub("Inventory Art", fid("Static")),
      CNAM: sub("Description", lstr("Description")),
    },
  },
  MISC: { name: "Misc. Item", flags: NON_PLAYABLE, subs: { DATA: OBJECT_DATA } },
  KEYM: { name: "Key", flags: NON_PLAYABLE, subs: { DATA: OBJECT_DATA } },
  SLGM: {
    name: "Soul Gem",
    flags: { 0x20000: "Can Hold NPC Soul" },
    subs: {
      DATA: OBJECT_DATA,
      SOUL: sub("Contained Soul", u8("Soul", { enum: SOUL_GEM })),
      SLCP: sub("Maximum Capacity", u8("Capacity", { enum: SOUL_GEM })),
      NAM0: sub("Linked To", fid("Soul Gem")),
    },
  },
  ALCH: {
    name: "Ingestible",
    flags: { 0x20000000: "Medicine" },
    subs: {
      DATA: sub("Weight", f32("Weight")),
      ENIT: sub(
        "Effect Data",
        struct("Effect Data", [
          i32("Value"),
          u32("Flags", { flags: sparse([[0, "No Auto-Calc"], [1, "Food Item"], [16, "Medicine"], [17, "Poison"]]) }),
          fid("Addiction"),
          f32("Addiction Chance"),
          fid("Sound - Consume"),
        ]),
      ),
    },
  },
  INGR: {
    name: "Ingredient",
    subs: {
      DATA: OBJECT_DATA,
      ENIT: sub("Effect Data", struct("Effect Data", [i32("Ingredient Value"), u32("Flags", { flags: sparse([[0, "No auto-calculation"], [1, "Food item"], [8, "References Persist"]]) })])),
    },
  },
  SCRL: {
    name: "Scroll",
    subs: {
      MDOB: sub("Menu Display Object", fid("Static")),
      DATA: sub("Item Data", struct("Data", [u32("Value"), f32("Weight")])),
      SPIT: SPELL_DATA,
    },
  },
  SPEL: { name: "Spell", subs: { MDOB: sub("Menu Display Object", fid("Static")), SPIT: SPELL_DATA } },
  ENCH: {
    name: "Object Effect",
    subs: {
      ENIT: sub(
        "Effect Data",
        struct("Effect Data", [
          i32("Enchantment Cost"),
          u32("Flags", { flags: ["No Auto-Calc", "", "Extend Duration On Recast"] }),
          u32("Cast Type", { enum: CAST }),
          i32("Enchantment Amount"),
          u32("Delivery", { enum: DELIVERY }),
          u32("Enchant Type", { enum: { 6: "Enchantment", 12: "Staff Enchantment" } }),
          f32("Charge Time"),
          fid("Base Enchantment"),
          fid("Worn Restrictions"),
        ]),
      ),
    },
  },
  MGEF: {
    name: "Magic Effect",
    subs: {
      MDOB: sub("Menu Display Object", fid("Static")),
      DATA: sub(
        "Data",
        struct("Data", [
          u32("Flags", { hex: true }),
          f32("Base Cost"),
          fid("Assoc. Item"),
          i32("Magic Skill", { enum: SKILL }),
          i32("Resist Value"),
          u16("Counter Effect Count"),
          unused(2),
          fid("Casting Light"),
          f32("Taper Weight"),
          fid("Hit Shader"),
          fid("Enchant Shader"),
          u32("Minimum Skill Level"),
          u32("Spellmaking Area"),
          f32("Spellmaking Casting Time"),
          f32("Taper Curve"),
          f32("Taper Duration"),
          f32("Second AV Weight"),
          u32("Archetype"),
          i32("Actor Value"),
          fid("Projectile"),
          fid("Explosion"),
          u32("Casting Type", { enum: CAST }),
          u32("Delivery", { enum: DELIVERY }),
          i32("Second Actor Value"),
          fid("Casting Art"),
          fid("Hit Effect Art"),
          fid("Impact Data"),
          f32("Skill Usage Multiplier"),
          fid("Dual Casting Art"),
          f32("Dual Casting Scale"),
          fid("Enchant Art"),
          fid("Hit Visuals"),
          fid("Enchant Visuals"),
          fid("Equip Ability"),
          fid("Image Space Modifier"),
          fid("Perk to Apply"),
          u32("Casting Sound Level", { enum: SOUND_LEVEL }),
          f32("Script Effect AI Score"),
          f32("Script Effect AI Delay Time"),
        ]),
      ),
      ESCE: sub("Counter Effect", fid("Magic Effect")),
      DNAM: sub("Magic Item Description", lstr("Description")),
    },
  },
  LVLI: {
    name: "Leveled Item",
    subs: { ...LEVELED, LVLF: sub("Flags", u8("Flags", { flags: ["Calculate from all levels <= player's level", "Calculate for each item in count", "Use All", "Special Loot"] })) },
  },
  LVLN: {
    name: "Leveled NPC",
    subs: { ...LEVELED, LVLF: sub("Flags", u8("Flags", { flags: ["Calculate from all levels <= player's level", "Calculate for each item in count"] })) },
  },
  LVSP: {
    name: "Leveled Spell",
    subs: { ...LEVELED, LVLF: sub("Flags", u8("Flags", { flags: ["Calculate from all levels <= player's level", "Calculate for each item in count", "Use All Spells"] })) },
  },
  CONT: {
    name: "Container",
    subs: {
      DATA: sub("Data", struct("Data", [u8("Flags", { flags: ["Allow Sounds When Animation", "Respawns", "Show Owner"] }), f32("Weight")])),
      SNAM: sub("Sound - Open", fid("Sound")),
      QNAM: sub("Sound - Close", fid("Sound")),
    },
  },
  COBJ: {
    name: "Constructible Object",
    subs: {
      CNAM: sub("Created Object", fid("Item")),
      BNAM: sub("Workbench Keyword", fid("Keyword")),
      NAM1: sub("Created Object Count", u16("Count")),
    },
  },
  FLST: { name: "FormID List", subs: { LNAM: sub("FormID", fid("Form")) } },
  OTFT: { name: "Outfit", subs: { INAM: sub("Items", array("Items", fid("Item"))) } },
  LIGH: {
    name: "Light",
    subs: {
      DATA: sub(
        "Data",
        struct("Data", [
          i32("Time"),
          u32("Radius"),
          struct("Color", [u8("Red"), u8("Green"), u8("Blue"), u8("Unused")]),
          u32("Flags", { flags: ["Dynamic", "Can be Carried", "Negative", "Flicker", "Unknown", "Off By Default", "Flicker Slow", "Pulse", "Pulse Slow", "Spot Light", "Shadow Spotlight", "Shadow Hemisphere", "Shadow Omnidirectional", "Portal-strict"] }),
          f32("Falloff Exponent"),
          f32("FOV"),
          f32("Near Clip"),
          f32("Flicker Period"),
          f32("Flicker Intensity Amplitude"),
          f32("Flicker Movement Amplitude"),
          u32("Value"),
          f32("Weight"),
        ]),
      ),
      FNAM: sub("Fade value", f32("Fade")),
      SNAM: sub("Sound", fid("Sound")),
    },
  },
  NPC_: {
    name: "Non-Player Character (Actor)",
    subs: {
      ACBS: sub(
        "Configuration",
        struct("Configuration", [
          u32("Flags", {
            flags: sparse([[0, "Female"], [1, "Essential"], [2, "Is CharGen Face Preset"], [3, "Respawn"], [4, "Auto-calc stats"], [5, "Unique"], [6, "Doesn't affect stealth meter"], [7, "PC Level Mult"], [8, "Use Template?"], [11, "Protected"], [14, "Summonable"], [16, "Doesn't bleed"], [18, "Bleedout Override"], [19, "Opposite Gender Anims"], [20, "Simple Actor"], [29, "Is Ghost"], [31, "Invulnerable"]]),
          }),
          i16("Magicka Offset"),
          i16("Stamina Offset"),
          u16("Level (or Level Mult x1000)"),
          u16("Calc min level"),
          u16("Calc max level"),
          u16("Speed Multiplier"),
          i16("Disposition Base (unused)"),
          u16("Template Flags", { flags: ["Use Traits", "Use Stats", "Use Factions", "Use Spell List", "Use AI Data", "Use AI Packages", "Use Model/Animation (unused)", "Use Base Data", "Use Inventory", "Use Script", "Use Def Pack List", "Use Attack Data", "Use Keywords"] }),
          i16("Health Offset"),
          u16("Bleedout Override"),
        ]),
      ),
      SNAM: sub("Faction", struct("Faction", [fid("Faction"), i8("Rank"), unused(3)])),
      INAM: sub("Death item", fid("Leveled Item")),
      VTCK: sub("Voice", fid("Voice Type")),
      TPLT: sub("Template", fid("NPC / Leveled NPC")),
      RNAM: sub("Race", fid("Race")),
      WNAM: sub("Skin", fid("Armor")),
      ANAM: sub("Far away model", fid("Armor")),
      ATKR: sub("Attack Race", fid("Race")),
      SPOR: sub("Spectator override package list", fid("Form List")),
      OCOR: sub("Observe dead body override package list", fid("Form List")),
      GWOR: sub("Guard warn override package list", fid("Form List")),
      ECOR: sub("Combat override package list", fid("Form List")),
      PRKZ: sub("Perk Count", u32("Count")),
      PRKR: sub("Perk", struct("Perk", [fid("Perk"), u8("Rank"), unused(3)])),
      AIDT: sub(
        "AI Data",
        struct("AI Data", [
          u8("Aggression", { enum: list(["Unaggressive", "Aggressive", "Very Aggressive", "Frenzied"]) }),
          u8("Confidence", { enum: list(["Cowardly", "Cautious", "Average", "Brave", "Foolhardy"]) }),
          u8("Energy Level"),
          u8("Responsibility", { enum: list(["Any crime", "Violence against enemies", "Property crime only", "No crime"]) }),
          u8("Mood", { enum: list(["Neutral", "Angry", "Fear", "Happy", "Sad", "Surprised", "Puzzled", "Disgusted"]) }),
          u8("Assistance", { enum: list(["Helps Nobody", "Helps Allies", "Helps Friends and Allies"]) }),
          u8("Aggro Radius Behavior", { enum: BOOL }),
          unused(1),
          u32("Warn"),
          u32("Warn/Attack"),
          u32("Attack"),
        ]),
      ),
      PKID: sub("AI Package", fid("Package")),
      CNAM: sub("Class", fid("Class")),
      SHRT: sub("Short Name", lstr("Short Name")),
      DATA: sub("Marker", bytes("Marker")),
      DNAM: sub(
        "Player Skills",
        struct("Player Skills", [
          ...["One Handed", "Two Handed", "Marksman", "Block", "Smithing", "Heavy Armor", "Light Armor", "Pickpocket", "Lockpicking", "Sneak", "Alchemy", "Speechcraft", "Alteration", "Conjuration", "Destruction", "Illusion", "Restoration", "Enchanting"].map((s) => u8(`${s} (value)`)),
          ...["One Handed", "Two Handed", "Marksman", "Block", "Smithing", "Heavy Armor", "Light Armor", "Pickpocket", "Lockpicking", "Sneak", "Alchemy", "Speechcraft", "Alteration", "Conjuration", "Destruction", "Illusion", "Restoration", "Enchanting"].map((s) => u8(`${s} (offset)`)),
          u16("Health"),
          u16("Magicka"),
          u16("Stamina"),
          unused(2),
          f32("Far away model distance"),
          u8("Geared up weapons"),
          unused(3),
        ]),
      ),
      PNAM: sub("Head Part", fid("Head Part")),
      HCLF: sub("Hair Color", fid("Color")),
      ZNAM: sub("Combat Style", fid("Combat Style")),
      GNAM: sub("Gift Filter", fid("Form List")),
      NAM5: sub("Unknown", u16("Unknown")),
      NAM6: sub("Height", f32("Height")),
      NAM7: sub("Weight", f32("Weight")),
      NAM8: sub("Sound Level", u32("Sound Level", { enum: SOUND_LEVEL })),
      DOFT: sub("Default Outfit", fid("Outfit")),
      SOFT: sub("Sleeping Outfit", fid("Outfit")),
      DPLT: sub("Default Package List", fid("Form List")),
      CRIF: sub("Crime Faction", fid("Faction")),
      FTST: sub("Head Texture", fid("Texture Set")),
      QNAM: sub("Texture Lighting", struct("Color", [f32("Red"), f32("Green"), f32("Blue")])),
      NAM9: sub("Face Morph", bytes("Values")),
      NAMA: sub("Face Parts", struct("Face Parts", [u32("Nose"), i32("Unknown"), u32("Eyes"), u32("Mouth")])),
      TINI: sub("Tint Index", u16("Index")),
      TINC: sub("Tint Color", struct("Color", [u8("Red"), u8("Green"), u8("Blue"), u8("Alpha")])),
      TINV: sub("Tint Interpolation Value", i32("Value", { div: 100 })),
      TIAS: sub("Tint Preset", i16("Preset")),
    },
  },
  FACT: {
    name: "Faction",
    subs: {
      XNAM: sub("Relation", struct("Relation", [fid("Faction"), i32("Modifier"), u32("Group Combat Reaction", { enum: list(["Neutral", "Enemy", "Ally", "Friend"]) })])),
      DATA: sub("Flags", u32("Flags", { flags: ["Hidden From NPC", "Special Combat", "", "", "", "", "Track Crime", "Ignore Crimes: Murder", "Ignore Crimes: Assault", "Ignore Crimes: Stealing", "Ignore Crimes: Trespass", "Do Not Report Crimes Against Members", "Crime Gold - Use Defaults", "Ignore Crimes: Pickpocket", "Vendor", "Can Be Owner", "Ignore Crimes: Werewolf"] })),
      JAIL: sub("Exterior Jail Marker", fid("Reference")),
      WAIT: sub("Follower Wait Marker", fid("Reference")),
      STOL: sub("Stolen Goods Container", fid("Reference")),
      PLCN: sub("Player Inventory Container", fid("Reference")),
      CRGR: sub("Shared Crime Faction List", fid("Form List")),
      JOUT: sub("Jail Outfit", fid("Outfit")),
      RNAM: sub("Rank Number", u32("Rank")),
      MNAM: sub("Male Title", lstr("Title")),
      FNAM: sub("Female Title", lstr("Title")),
      VEND: sub("Vendor Buy/Sell List", fid("Form List")),
      VENC: sub("Merchant Container", fid("Reference")),
    },
  },
  STAT: {
    name: "Static",
    subs: { DNAM: sub("Direction Material", struct("Direction Material", [f32("Max Angle (30-120)"), fid("Material")])), MNAM: sub("Distant LOD", bytes("LOD models")) },
  },
  ACTI: {
    name: "Activator",
    subs: {
      PNAM: sub("Marker Color", struct("Color", [u8("Red"), u8("Green"), u8("Blue"), u8("Unused")])),
      SNAM: sub("Sound - Looping", fid("Sound")),
      VNAM: sub("Sound - Activation", fid("Sound")),
      WNAM: sub("Water Type", fid("Water")),
      RNAM: sub("Activate Text Override", lstr("Text")),
      FNAM: sub("Flags", u16("Flags", { flags: ["No Displacement", "Ignored by Sandbox"] })),
      KNAM: sub("Interaction Keyword", fid("Keyword")),
    },
  },
  DOOR: {
    name: "Door",
    subs: {
      SNAM: sub("Sound - Open", fid("Sound")),
      ANAM: sub("Sound - Close", fid("Sound")),
      BNAM: sub("Sound - Loop", fid("Sound")),
      FNAM: sub("Flags", u8("Flags", { flags: ["", "Automatic", "Hidden", "Minimal Use", "Sliding", "Do Not Open in Combat Search"] })),
    },
  },
  FURN: {
    name: "Furniture",
    subs: {
      KNAM: sub("Interaction Keyword", fid("Keyword")),
      FNAM: sub("Flags", u16("Flags", { hex: true })),
      MNAM: sub("Active Markers / Flags", u32("Flags", { hex: true })),
      WBDT: sub("Workbench Data", struct("Workbench Data", [u8("Bench Type", { enum: list(["None", "Create Object", "Smithing Weapon", "Enchanting", "Enchanting Experiment", "Alchemy", "Alchemy Experiment", "Smithing Armor"]) }), i8("Uses Skill", { enum: SKILL })])),
      NAM1: sub("Associated Spell", fid("Spell")),
    },
  },
  CELL: {
    name: "Cell",
    subs: {
      DATA: sub("Flags", u16("Flags", { flags: ["Is Interior Cell", "Has Water", "Can't Travel From Here", "No LOD Water", "", "Public Area", "Hand Changed", "Show Sky", "Use Sky Lighting"] })),
      XCLC: sub("Grid", struct("Grid", [i32("X"), i32("Y"), u32("Force Hide Land", { hex: true })])),
      XCLL: sub("Lighting", bytes("Lighting")),
      LTMP: sub("Lighting Template", fid("Lighting Template")),
      XCLW: sub("Water Height", f32("Height")),
      XCLR: sub("Regions", array("Regions", fid("Region"))),
      XCWT: sub("Water", fid("Water")),
      XCAS: sub("Acoustic Space", fid("Acoustic Space")),
      XCMO: sub("Music Type", fid("Music Type")),
      XCIM: sub("Image Space", fid("Image Space")),
      XLCN: sub("Location", fid("Location")),
    },
  },
  REFR: {
    name: "Placed Object",
    subs: {
      DATA: sub("Position/Rotation", struct("Position/Rotation", [struct("Position", [f32("X"), f32("Y"), f32("Z")]), struct("Rotation (radians)", [f32("X"), f32("Y"), f32("Z")])])),
      XTEL: sub("Teleport Destination", struct("Teleport Destination", [fid("Door"), struct("Position", [f32("X"), f32("Y"), f32("Z")]), struct("Rotation (radians)", [f32("X"), f32("Y"), f32("Z")]), u32("Flags", { flags: ["No Alarm"] })])),
      XNDP: sub("Navigation Door Link", struct("Link", [fid("Navigation Mesh"), u16("Teleport Marker Triangle"), unused(2)])),
    },
  },
  ACHR: {
    name: "Placed NPC",
    subs: {
      DATA: sub("Position/Rotation", struct("Position/Rotation", [struct("Position", [f32("X"), f32("Y"), f32("Z")]), struct("Rotation (radians)", [f32("X"), f32("Y"), f32("Z")])])),
    },
  },
  QUST: {
    name: "Quest",
    subs: {
      DNAM: sub("General", struct("General", [u16("Flags", { flags: ["Start Game Enabled", "", "Wilderness Encounter", "Allow Repeated Stages", "", "", "", "", "Run Once", "Exclude From Dialogue Export", "Warn On Alias Fill Failure"] }), u8("Priority"), u8("Form Version"), bytes("Unknown", 4), u32("Type", { enum: list(["None", "Main Quest", "Mages' Guild", "Thieves' Guild", "Dark Brotherhood", "Companion Quests", "Miscellaneous", "Daedric", "Side Quest", "Civil War", "DLC01 - Vampire", "DLC02 - Dragonborn"]) })])),
      ENAM: sub("Event", bytes("Event", 4)),
      FLTR: sub("Object Window Filter", str("Filter")),
      NNAM: sub("Objective Text", lstr("Text")),
      CNAM: sub("Log Entry", lstr("Text")),
      ANAM: sub("Next Alias ID", u32("ID")),
      ALID: sub("Alias Name", str("Name")),
    },
  },
  MESG: {
    name: "Message",
    subs: {
      INAM: sub("Icon (unused)", fid("Icon")),
      QNAM: sub("Owner Quest", fid("Quest")),
      DNAM: sub("Flags", u32("Flags", { flags: ["Message Box", "Auto Display"] })),
      TNAM: sub("Display Time", u32("Seconds")),
      ITXT: sub("Button Text", lstr("Text")),
    },
  },
  PERK: {
    name: "Perk",
    subs: {
      DATA: sub("Data", struct("Data", [u8("Trait", { enum: BOOL }), u8("Level"), u8("Num Ranks"), u8("Playable", { enum: BOOL }), u8("Hidden", { enum: BOOL })])),
      NNAM: sub("Next Perk", fid("Perk")),
    },
  },
  RACE: { name: "Race", subs: { SPCT: COMMON["SPCT"]!, SPLO: COMMON["SPLO"]! } },
  WRLD: { name: "Worldspace", subs: { WNAM: sub("Parent Worldspace", fid("Worldspace")), CNAM: sub("Climate", fid("Climate")), NAM2: sub("Water", fid("Water")) } },
};

/** Group/record signature to readable name, as shown in TES5Edit's tree. */
export const SIGNATURE_NAMES: Record<string, string> = {
  AACT: "Action", ACHR: "Placed NPC", ACTI: "Activator", ADDN: "Addon Node", ALCH: "Ingestible", AMMO: "Ammunition",
  ANIO: "Animated Object", APPA: "Alchemical Apparatus", ARMA: "Armor Addon", ARMO: "Armor", ARTO: "Art Object",
  ASPC: "Acoustic Space", ASTP: "Association Type", AVIF: "Actor Value Information", BOOK: "Book",
  BPTD: "Body Part Data", CAMS: "Camera Shot", CELL: "Cell", CLAS: "Class", CLFM: "Color", CLMT: "Climate",
  COBJ: "Constructible Object", COLL: "Collision Layer", CONT: "Container", CPTH: "Camera Path",
  CSTY: "Combat Style", DEBR: "Debris", DIAL: "Dialog Topic", DLBR: "Dialog Branch", DLVW: "Dialog View",
  DOBJ: "Default Object Manager", DOOR: "Door", DUAL: "Dual Cast Data", ECZN: "Encounter Zone",
  EFSH: "Effect Shader", ENCH: "Object Effect", EQUP: "Equip Type", EXPL: "Explosion", EYES: "Eyes",
  FACT: "Faction", FLOR: "Flora", FLST: "FormID List", FSTP: "Footstep", FSTS: "Footstep Set",
  FURN: "Furniture", GLOB: "Global", GMST: "Game Setting", GRAS: "Grass", HAZD: "Hazard", HDPT: "Head Part",
  IDLE: "Idle Animation", IDLM: "Idle Marker", IMAD: "Image Space Adapter", IMGS: "Image Space",
  INFO: "Dialog Response", INGR: "Ingredient", IPCT: "Impact", IPDS: "Impact Data Set", KEYM: "Key",
  KYWD: "Keyword", LAND: "Landscape", LCRT: "Location Reference Type", LCTN: "Location", LENS: "Lens Flare",
  LGTM: "Lighting Template", LIGH: "Light", LSCR: "Load Screen", LTEX: "Landscape Texture",
  LVLI: "Leveled Item", LVLN: "Leveled NPC", LVSP: "Leveled Spell", MATO: "Material Object",
  MATT: "Material Type", MESG: "Message", MGEF: "Magic Effect", MISC: "Misc. Item", MOVT: "Movement Type",
  MSTT: "Moveable Static", MUSC: "Music Type", MUST: "Music Track", NAVI: "Navigation Mesh Info Map",
  NAVM: "Navigation Mesh", NPC_: "Non-Player Character (Actor)", OTFT: "Outfit", PACK: "Package",
  PARW: "Placed Arrow", PBAR: "Placed Barrier", PBEA: "Placed Beam", PCON: "Placed Cone/Voice",
  PERK: "Perk", PFLA: "Placed Flame", PGRE: "Placed Projectile", PHZD: "Placed Hazard",
  PMIS: "Placed Missile", PROJ: "Projectile", QUST: "Quest", RACE: "Race", REFR: "Placed Object",
  REGN: "Region", RELA: "Relationship", REVB: "Reverb Parameters", RFCT: "Visual Effect", SCEN: "Scene",
  SCRL: "Scroll", SHOU: "Shout", SLGM: "Soul Gem", SMBN: "Story Manager Branch Node",
  SMEN: "Story Manager Event Node", SMQN: "Story Manager Quest Node", SNCT: "Sound Category",
  SNDR: "Sound Descriptor", SOPM: "Sound Output Model", SOUN: "Sound Marker", SPEL: "Spell",
  SPGD: "Shader Particle Geometry", STAT: "Static", TACT: "Talking Activator", TES4: "File Header",
  TREE: "Tree", TXST: "Texture Set", VOLI: "Volumetric Lighting", VTYP: "Voice Type", WATR: "Water",
  WEAP: "Weapon", WOOP: "Word of Power", WRLD: "Worldspace", WTHR: "Weather",
};

export function recordFlagNames(sig: string): Record<number, string> {
  return { ...COMMON_RECORD_FLAGS, ...RECORD_DEFS[sig]?.flags };
}

export function findSubDef(recordSig: string, subSig: string): SubDef | undefined {
  return RECORD_DEFS[recordSig]?.subs[subSig] ?? COMMON[subSig];
}

/** Signatures known for a record type, for the "add field" picker. */
export function knownSubSignatures(recordSig: string): string[] {
  const own = Object.keys(RECORD_DEFS[recordSig]?.subs ?? {});
  return [...new Set([...own, "EDID", "FULL", "DESC", "OBND", "MODL", "KSIZ", "KWDA", "CTDA", "CNTO", "COCT", "EFID", "EFIT"])];
}
