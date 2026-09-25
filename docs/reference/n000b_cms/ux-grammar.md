# n000b CMS — UX Grammar (the *form* half)

> **Status:** Interpretation, written by an AI (GitHub Copilot, 2026-09-13). This is **not** the design —
> it is a hypothesis about the design, offered for correction. Where it is wrong, David is the authority.
> **Method:** verified by *looking* at the running editor and the screenshots in `screenshots/`.
> DOM measurement was used only to confirm what looking already showed.
> **Complements, does not repeat:** `n000b_cms_spec.md` and `tour-notes.md` document **behaviour**
> (what the editor does — block types, media paths, save, recursion bounds). This document covers
> **form** — how the editor expresses containment and hierarchy.
> **Why it exists:** the previous rebuild of this UX failed because the form half was never written
> down. It survived only as CSS metrics and DOM structure. This is an attempt to write it down.

---

## 0. Method note — how the previous attempt went wrong

Reading the DOM produced structurally plausible claims that were **wrong in the one dimension that
matters**, and they pointed the scrap-vs-rebuild decision the wrong way:

| Claim (from probing) | Reality (from looking) |
|---|---|
| "The reference has no per-block formatting toolbar; a real editor uses one contextual toolbar that follows focus." | **False.** Every rich-text block carries a persistent toolbar. The probe's selector `.trumbowyg-toolbar` matched nothing; the real element is `trumbowyg-box trumbowyg-editor-visible` — present on 6 of 11 blocks. The "one contextual toolbar" claim was the **training prior**, not the reference. |
| "Delete is hidden behind a `⋯` menu; not exposed on the container." | **False.** Every container has a direct ✕ (`nui-cms-block-button_delete`). The `⋯` is a `<span>...</span>` inside `.classes` — a class *display*, not a menu. |

**Rule for any future work on this UX: look at the thing first. Probe only to confirm what looking showed.**
Structure is recoverable by measurement; the design lives in the appearance, and measurement will
confidently return a wrong answer about appearance.

---

## 1. The one idea

**Structure is expressed by shading, not by strokes.**

The editor says *"this is part of this"* with fill. There are effectively no borders anywhere — at most a
sub-pixel lighter edge on the outermost container. Everything else that would conventionally be a border
is a tonal step instead.

This is deliberate and load-bearing: it is why the editor can nest (section → columns → column → block)
without spending strokes per level, and why it reads as a surface rather than as a wireframe.

## 2. Contrast budget (the binding rule)

**The contrast budget belongs to content.**

Every structural element — bands, labels, index badges, icons, affordances — must sit *below* the
contrast of the content it holds. Each block pops because its content is the loudest thing inside it,
and the frame between blocks says nothing.

This single rule explains every other observation below. It is also why the reference can afford a
toolbar on every block: the toolbar is dim enough that it never enters the contest with the text.

**Our editor inverts it.** Its brightest pixels are chrome: white toolbar icons inside a bordered box,
the `Media: Hero` / `Default Surface` select chips, the `<>` toggle, high-contrast index badges, the
`Document Metadata` band. The content is the quietest thing on screen. We spent the contrast budget on
the frame.

### 2.1 Derived requirement — content must be able to carry the top slot

If structure is subordinate, the content has to *be* the loudest thing, which means it must be rendered
as the page will render it: larger, airier, wider measure. Our content is small, tightly led and
narrow-measured.

Dimming the chrome without lifting the type does not produce the reference — it produces a flat grey
screen. The two move together or not at all.

## 3. The tonal ladder

Containment is one step per level, and **content recesses back down inside its own container**:

| Level | Treatment |
|---|---|
| page | the base |
| section slab | one step away from the base |
| group / columns slab | one step further |
| column panel | one step further |
| block header band | sits at its surrounding slab's level |
| **block content** | **recesses — darker than its own header band** |

The direction of the last row is the part that is easy to miss: a block's body is *not* lighter than its
band. The band marks the block; the body recedes into the slab so the content floats on it.

> **Technique note:** the old CMS implemented the ladder as layered translucencies over one background.
> **That is an implementation detail, not a requirement** (David, 2026-09-13: *"It doesnt need to be done
> with alpha's .. but the 'contrast budget' is the right framing."*). The binding thing is the contrast
> relationship. NUI's existing `--color-shade1..9` ramp is a good carrier precisely because it is already
> `light-dark()` aware, so the ladder survives theming without a per-theme polarity decision.

> **Not part of the grammar:** the faint large letterform in the slab backgrounds. That is stylistic
> background treatment (David), not a hierarchy signal. Do not model it as one.

## 4. Affordances: quiet at rest, explaining themselves on approach

Structural affordances sit at near-invisible contrast at rest and **pop on hover**. The lift is what
communicates *"there is functionality behind this"* without spending contrast while the author is reading.

David is explicit that this trades away accessibility friendliness for calm, and that the trade is
understood rather than accidental.

**Two gaps worth closing deliberately — both cost the design nothing:**

- **Keyboard.** Pair every hover reveal with a `:focus-visible` reveal. Same pop, same explanation,
  keyboard users included.
- **Touch.** There is no hover at all. Either the first tap performs the reveal, or the container's own
  edit affordance carries it.

**Implementation consequence:** the visual pass cannot be *"dim the chrome"*. Dimming **without** the
reveal mechanism produces an editor whose controls nobody can find — which is the failure mode this UX
sits closest to. Dim and reveal land together.

## 5. Header identity: the preset is text

A container header carries, left to right: drag dots, an index, and the identity.

The identity is **static small-caps text** — `SECTION`, `COLUMNS`, `COVER`, `TEXT`, `RICHTEXT - LOREM`.
So **the preset *is* the label**, rendered as type, not as a control. There is no bordered select in any
header. Column containers read `C1` / `C2`, and blocks inside them carry their own index within the column.

Right side: the class display (`.`-placeholder when no class is set) and a ✕. Nothing else. No
per-container up/down buttons, no code toggle, no editable select.

## 6. Content fidelity

The editor renders content at the fidelity of the delivered page — its own type scale and measure, not a
compressed admin approximation. This is what lets the contrast budget be spent on content: the content
earns it. A block body that renders small and tight cannot hold the top slot.

---

## 7. Gates (checkable, no taste required)

| Gate | Test |
|---|---|
| Stroke budget | Count borders in the document. Target ≤ 1 for the whole document (outermost edge only). **Zero inside a block.** |
| Contrast budget | For each structural element, is it lower-contrast than the content it contains? Any answer of "no" fails. |
| Chrome at rest | Structural chrome sits far below content contrast at rest. |
| Reveal parity | Every hover reveal has a `:focus-visible` twin. |
| Header identity | No bordered control in a container header; the preset renders as text. |
| Content weight | Content renders at page fidelity (scale + measure), not admin-compressed. |
| Ladder direction | A block's content is *darker* than its own header band. |

## 8. Structure vs presentation (the decision this settles)

**The structure already matches.** Both editors have the same skeleton: drag dots, index, identity, and a
✕ per container; a toolbar per rich-text block; `+` strips per container; the same nesting
(section → columns → column → block).

David: *"it follows the same structure, just how it is presented is different."*

Therefore **there is nothing to rebuild.** The gap is presentational:

| | Reference | Ours (as of 2026-09-13) |
|---|---|---|
| Containment | shading, one step per level | border + shade + shadow at the same level (4 nested strokes) |
| Container headers | identity as small-caps text + ✕ | bordered select chip + `<>` toggle + index badge + ↑ ↓ ✕ |
| Toolbar | flat tonal band, dim icons, wide spacing | bordered rounded box, bright tight icons — loudest element in the block |
| Content | large, airy, wide measure | small, tight, narrow, dead side margins |
| Media | image fills its container | image letterboxed inside a bordered box with its own frame |
| Contrast | reserved for content | reserved for chrome |

## 9. Not understood (honest gaps — do not guess these)

- The spacing rhythm and how it changes with depth (margins look smaller for deeper levels, but I have not measured or confirmed it).
- How a block's `label` and `class` are *edited* (spec §3.7 says label click and the class affordance; I have not seen either in action).
- Toolbar behaviour with several blocks in play (does it persist, shift, or attach to the focused block).
- The empty-state of a container, and what a container looks like with no content.
- Whether the outermost sub-pixel edge is deliberate or a rendering artifact.
- The touch story, if any, in the original.

## 10. If this document is right, the work is

A presentational pass on the existing editor — **not** a rebuild:

1. Set the ladder: one tonal step per nesting level, content recessed inside its band.
2. Strike the strokes: remove the block/columns/column boxes; keep at most the outermost edge.
3. Quiet the headers: preset as small-caps text; move ↑ ↓ `<>` behind the class affordance or into a
   reveal; keep ✕.
4. Recess the toolbar: flat band, dim icons, no border.
5. Lift the content: page-fidelity type scale and measure.
6. Install the reveal: hover **and** `:focus-visible`.
