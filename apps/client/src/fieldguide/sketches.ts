// Owner: fieldguide (v1.2) client. Field-guide sketches as inline SVG: pencil drawings of the four monsters (seen) and
// blurred silhouettes (heard only). Pure data + an SVG string builder, so the booklet renders them with
// dangerouslySetInnerHTML (static markup, no user input) and a node preview can rasterise the same strings.
// No page text here: only drawing annotations.
import type { MonsterKind } from '@dead-air/shared/state.ts';

export interface Stroke {
  d: string;
  /** stroke width (default 1.6) */
  w?: number;
  /** 'line' graphite outline (default), 'detail' thin graphite, 'shade' hatched fill, 'accent' red pencil, 'fill' flat graphite,
   *  'eye' faint violet */
  k?: 'line' | 'detail' | 'shade' | 'accent' | 'fill' | 'eye';
  op?: number;
}
export interface Sketch {
  /** closed shapes: the silhouette (heard-only) and the paper-white underlay of the drawing */
  body: string[];
  strokes: Stroke[];
  /** red-pencil notes: [x, y, text, rotateDeg?] */
  notes: [number, number, string, number?][];
}

const W = 320, H = 300;

export const SKETCHES: Readonly<Record<MonsterKind, Sketch>> = {
  // ------------------------------------------------------------------ eyeless hound: side view, head low, hunting
  hound: {
    body: [
      'M34 214 C44 200 64 186 86 176 C98 170 108 160 118 150 C126 138 134 124 146 116 C160 110 176 112 190 116 C208 120 226 122 240 124 '
      + 'C252 126 262 134 264 146 C266 160 262 172 256 180 C262 196 270 212 268 222 L262 252 C266 256 272 258 276 260 L250 262 L248 256 '
      + 'L252 226 C244 212 236 200 232 188 C228 176 224 166 218 160 C202 164 184 180 166 192 C156 198 144 200 136 198 C134 212 132 228 130 252 '
      + 'L134 258 C128 260 118 262 110 262 L108 256 L112 232 C114 216 114 200 118 186 C112 182 104 186 98 192 C84 204 62 214 44 220 C38 220 34 218 34 214 Z',
      // far-side legs
      'M150 190 C150 214 148 236 146 256 L132 262 L156 262 L158 256 C160 236 162 214 164 194 Z',
      'M222 176 C226 196 232 214 234 230 L238 258 L230 262 L252 262 L246 256 L244 226 C240 206 236 190 234 178 Z',
    ],
    strokes: [
      { d: 'M150 190 C150 214 148 236 146 256 L132 262 L156 262 L158 256 C160 236 162 214 164 194', w: 1.1, k: 'detail', op: 0.6 },
      { d: 'M222 176 C226 196 232 214 234 230 L238 258 L230 262 L252 262 L246 256 L244 226 C240 206 236 190 234 178', w: 1.1, k: 'detail', op: 0.6 },
      { d: 'M150 196 C152 220 150 240 148 256 L156 258 C158 238 160 216 162 196 Z M226 180 C230 200 236 216 238 232 L242 256 L246 256 L242 226 C238 206 234 190 232 180 Z', k: 'shade', op: 0.55 },
      // near side outline, double pass
      { d: 'M34 214 C44 200 64 186 86 176 C98 170 108 160 118 150 C126 138 134 124 146 116 C160 110 176 112 190 116 C208 120 226 122 240 124 C252 126 262 134 264 146 C266 160 262 172 256 180 C262 196 270 212 268 222 L262 252', w: 2 },
      { d: 'M262 252 C266 256 272 258 276 260 L250 262 L248 256 L252 226 C244 212 236 200 232 188 C228 176 224 166 218 160 C202 164 184 180 166 192 C156 198 144 200 136 198 C134 212 132 228 130 252', w: 1.8 },
      { d: 'M130 252 L134 258 C128 260 118 262 110 262 L108 256 L112 232 C114 216 114 200 118 186 C112 182 104 186 98 192 C84 204 62 214 44 220 C38 220 34 218 34 214', w: 1.8 },
      { d: 'M36 212 C46 199 66 187 87 178 C99 172 109 162 119 152 C127 140 135 127 147 119 C161 113 177 115 190 119', w: 0.8, op: 0.4 },
      // hackles along the neck and withers
      { d: 'M118 150 l-7 -7 M124 142 l-6 -9 M130 133 l-5 -10 M137 125 l-3 -11 M144 119 l-2 -11 M152 115 l0 -10 M161 113 l1 -9 M171 113 l2 -8', w: 1.2 },
      // ribs over the deep chest
      { d: 'M150 128 C142 146 142 168 150 188 M162 124 C155 144 155 166 162 186 M174 122 C168 142 168 162 175 180 M186 122 C181 140 181 158 187 172', w: 1.05, k: 'detail', op: 0.85 },
      // hatched shadows: neck underside, belly, hind thigh
      { d: 'M98 192 C108 184 116 184 120 188 C122 176 128 160 138 150 C126 164 114 176 98 192 Z', k: 'shade', op: 0.9 },
      { d: 'M136 198 C150 200 162 196 170 190 C186 178 204 164 218 160 C210 158 196 166 180 176 C164 186 150 192 136 194 Z', k: 'shade', op: 0.9 },
      { d: 'M240 126 C254 130 262 140 262 154 C262 168 256 178 252 186 C246 176 244 156 240 126 Z M236 196 C244 206 250 214 252 226 L248 254 L246 228 Z', k: 'shade', op: 0.75 },
      // ear pinned back
      { d: 'M108 160 C114 150 122 146 128 147 C122 152 116 158 112 165', w: 1.3 },
      // the long jaw: gash, teeth, stitched-shut sockets, nostril
      { d: 'M37 215 C52 208 72 198 94 186', w: 1.4 },
      { d: 'M41 214 l2 5 l2 -6 l3 6 l2 -6 l3 6 l2 -7 l3 7 l2 -7 l3 6 l2 -7 l3 6 l2 -7 l3 6 l2 -6 l3 5 l2 -6 l3 4', w: 0.9, k: 'detail' },
      { d: 'M88 172 l8 3 M90 168 l2 8 M94 169 l2 8', w: 0.95, k: 'detail' },
      { d: 'M38 208 l3 1', w: 1.8 },
      // low hooked tail
      { d: 'M262 140 C278 150 286 170 284 196 C283 206 278 212 272 214', w: 1.4 },
      // claws
      { d: 'M110 262 q-5 1 -8 5 M117 262 q-4 2 -6 6 M124 262 q-3 2 -4 6 M250 262 q-5 1 -8 5 M257 262 q-4 2 -6 6 M264 262 q-3 2 -4 6', w: 1.1 },
      // floor
      { d: 'M12 266 C80 264 200 266 306 263', w: 0.9, k: 'detail', op: 0.6 },
      // red pencil
      { d: 'M92 166 C88 140 92 112 110 92', w: 1.2, k: 'accent' },
      { d: 'M103 93 l8 -2 l-2 8', w: 1.2, k: 'accent' },
    ],
    notes: [[100, 84, 'NO EYES', -4], [170, 290, 'hunts by ear', -2]],
  },

  // ------------------------------------------------------------------ the Listener: very tall, long neck, head cocked
  listener: {
    body: [
      // tilted head
      'M186 24 C196 30 198 46 190 58 C184 68 174 72 168 66 C160 58 158 44 166 32 C172 24 180 22 186 24 Z',
      // neck, hunched shoulders, torso, legs
      'M168 64 C162 78 156 90 150 104 C138 106 128 108 122 116 C120 140 124 166 132 192 C132 216 130 248 124 284 L136 285 '
      + 'C142 254 146 226 150 204 C156 226 162 254 170 285 L182 284 C176 250 172 218 172 196 C182 170 188 142 186 118 '
      + 'C180 110 170 106 162 106 C166 94 172 82 178 68 Z',
      // left arm hanging past the knee
      'M124 116 C112 136 106 160 104 184 C102 206 100 228 96 246 L90 262 L95 263 L100 250 L101 266 L106 266 L106 250 L110 263 L115 261 '
      + 'L111 246 C114 228 116 208 118 188 C120 166 126 144 134 126 Z',
      // right arm reaching forward
      'M184 116 C196 134 204 156 206 180 C208 202 212 222 218 238 L224 252 L219 255 L213 243 L214 259 L209 260 L207 245 L203 257 L198 255 '
      + 'L201 240 C196 222 192 202 190 182 C188 160 180 140 172 126 Z',
    ],
    strokes: [
      { d: 'M186 24 C196 30 198 46 190 58 C184 68 174 72 168 66 C160 58 158 44 166 32 C172 24 180 22 186 24', w: 1.8 },
      { d: 'M185 27 C194 33 196 46 189 57', w: 0.8, op: 0.45 },
      { d: 'M162 38 C162 50 166 60 172 66 C164 62 160 50 162 38 Z', k: 'shade', op: 0.8 },
      // faint violet eyes, slanted with the head
      { d: 'M172 42 l6 4 M182 36 l5 4', w: 2, k: 'eye' },
      // neck with vertebrae
      { d: 'M168 64 C162 78 156 90 150 104 M178 68 C172 82 166 94 162 106', w: 1.5 },
      { d: 'M165 74 l10 3 M161 82 l10 3 M157 90 l10 3 M154 98 l9 3', w: 0.75, k: 'detail', op: 0.8 },
      // body
      { d: 'M150 104 C138 106 128 108 122 116 C120 140 124 166 132 192 C132 216 130 248 124 284 L136 285 C142 254 146 226 150 204', w: 1.7 },
      { d: 'M150 204 C156 226 162 254 170 285 L182 284 C176 250 172 218 172 196 C182 170 188 142 186 118 C180 110 170 106 162 106', w: 1.7 },
      // ribcage, sternum, hips
      { d: 'M154 112 L154 170 M132 126 C142 131 164 131 176 124 M131 138 C142 144 164 144 178 136 M132 150 C143 156 164 156 178 148 M135 162 C145 167 162 167 174 160 M136 190 C146 196 160 196 170 192', w: 0.9, k: 'detail' },
      { d: 'M126 118 C124 144 128 168 134 190 C142 174 144 148 140 122 Z', k: 'shade', op: 0.8 },
      { d: 'M170 200 C172 232 176 260 180 282 L182 284 C176 250 172 218 172 196 Z M130 220 C130 246 128 266 126 282 L130 283 C134 260 136 238 136 214 Z', k: 'shade', op: 0.7 },
      { d: 'M128 236 q6 -3 10 1 M168 236 q6 -3 10 1', w: 0.9, k: 'detail' },
      // arms + spindly fingers
      { d: 'M124 116 C112 136 106 160 104 184 C102 206 100 228 96 246 L90 262 M95 263 L100 250 L101 266 M106 266 L106 250 L110 263 M115 261 L111 246 C114 228 116 208 118 188 C120 166 126 144 134 126', w: 1.5 },
      { d: 'M184 116 C196 134 204 156 206 180 C208 202 212 222 218 238 L224 252 M219 255 L213 243 L214 259 M209 260 L207 245 L203 257 M198 255 L201 240 C196 222 192 202 190 182 C188 160 180 140 172 126', w: 1.5 },
      { d: 'M106 182 q5 3 11 0 M190 180 q6 3 12 -1', w: 0.8, k: 'detail' },
      { d: 'M108 136 C104 160 104 184 102 206 C106 186 108 162 112 140 Z M198 140 C204 160 206 182 208 204 C204 184 200 162 194 144 Z', k: 'shade', op: 0.65 },
      // floor
      { d: 'M64 290 C130 288 200 290 266 288', w: 0.9, k: 'detail', op: 0.6 },
      // red pencil: height + head note
      { d: 'M248 24 L248 286 M241 24 h14 M241 286 h14', w: 1, k: 'accent' },
      { d: 'M112 36 C130 26 148 24 160 28', w: 1.1, k: 'accent' },
      { d: 'M154 23 l7 5 l-7 4', w: 1.1, k: 'accent' },
    ],
    notes: [[258, 150, '2.4 m?', 90], [20, 34, 'head always', -5], [26, 52, 'tilted', -5]],
  },

  // ------------------------------------------------------------------ jointed display figure, cracked plaster, reaching
  mannequin: {
    body: [
      // head, turned slightly
      'M164 24 C178 25 186 38 184 52 C182 66 172 76 161 75 C150 74 142 64 142 50 C142 36 151 24 164 24 Z',
      // neck, torso, hips, legs
      'M156 75 L156 88 C140 90 128 96 124 106 C123 128 128 148 134 164 C130 176 128 188 130 200 L136 282 L150 283 L158 208 '
      + 'L166 208 L172 283 L186 282 L192 200 C194 188 192 176 188 164 C194 148 198 128 198 106 C194 96 182 90 168 88 L168 75 Z',
      // left arm raised, reaching toward the viewer
      'M126 104 C112 108 100 118 92 132 C84 146 76 156 66 164 L56 170 L60 176 L72 172 C84 164 94 152 102 140 C110 128 120 118 132 114 Z',
      // right arm low, fingers spread
      'M196 104 C208 112 214 128 216 146 C218 162 222 176 228 188 L232 198 L226 202 L220 192 C212 178 208 162 206 148 C204 132 198 120 190 112 Z',
    ],
    strokes: [
      { d: 'M164 24 C178 25 186 38 184 52 C182 66 172 76 161 75 C150 74 142 64 142 50 C142 36 151 24 164 24', w: 1.8 },
      { d: 'M165 26 C177 28 183 40 182 53', w: 0.8, op: 0.4 },
      { d: 'M146 36 C142 46 143 62 150 70 C146 58 146 46 148 36 Z', k: 'shade', op: 0.7 },
      // faceless: brow ridge, nose bump
      { d: 'M151 48 C155 46 159 46 162 48 M167 47 C170 45 174 45 177 47 M164 50 C165 56 166 60 163 62', w: 0.8, k: 'detail', op: 0.75 },
      // torso, hips, legs
      { d: 'M156 75 L156 88 C140 90 128 96 124 106 C123 128 128 148 134 164 C130 176 128 188 130 200 L136 282 L150 283 L158 208 L166 208 L172 283 L186 282 L192 200 C194 188 192 176 188 164 C194 148 198 128 198 106 C194 96 182 90 168 88 L168 75', w: 1.7 },
      { d: 'M134 164 C152 171 172 171 188 164 M162 92 L162 164 M142 112 C150 120 156 124 162 124 C168 124 176 120 182 112', w: 0.8, k: 'detail' },
      // ball joints
      { d: 'M130 106 a7 7 0 1 0 0.1 0 M192 106 a7 7 0 1 0 0.1 0 M141 238 a6 6 0 1 0 0.1 0 M180 238 a6 6 0 1 0 0.1 0 M96 136 a5 5 0 1 0 0.1 0 M216 150 a5 5 0 1 0 0.1 0', w: 1.1, k: 'detail' },
      // arms + fingers
      { d: 'M126 104 C112 108 100 118 92 132 C84 146 76 156 66 164 L56 170 L60 176 L72 172 C84 164 94 152 102 140 C110 128 120 118 132 114', w: 1.5 },
      { d: 'M56 170 l-9 -2 M57 173 l-9 3 M59 176 l-7 7 M62 177 l-3 9', w: 1, k: 'detail' },
      { d: 'M196 104 C208 112 214 128 216 146 C218 162 222 176 228 188 L232 198 L226 202 L220 192 C212 178 208 162 206 148 C204 132 198 120 190 112', w: 1.5 },
      { d: 'M232 198 l5 7 M229 200 l3 9 M226 202 l0 8 M223 199 l-3 7', w: 1, k: 'detail' },
      // cracks in the plaster
      { d: 'M174 28 l-4 8 l5 4 l-6 9 M150 122 l6 8 l-3 6 l7 10 M178 132 l-5 7 l4 5 l-3 6 M142 222 l5 9 l-2 7 M100 128 l-5 5 l2 5', w: 0.9, k: 'detail' },
      // shading
      { d: 'M126 108 C126 130 132 150 136 166 C132 180 130 192 132 204 L138 280 L142 280 L136 202 C136 180 142 150 138 112 Z', k: 'shade', op: 0.75 },
      { d: 'M168 210 L174 280 L184 280 L188 206 C182 214 176 214 168 210 Z', k: 'shade', op: 0.55 },
      // broken display stand
      { d: 'M118 290 C140 286 182 286 204 290 M160 288 l-6 -6 l4 -2', w: 1, k: 'detail', op: 0.7 },
      // red pencil: motion marks + arrow to the head
      { d: 'M240 208 C252 216 258 230 258 244 M250 204 C264 216 270 232 268 250', w: 1, k: 'accent' },
      { d: 'M98 46 C112 40 126 40 138 46', w: 1.1, k: 'accent' },
      { d: 'M132 40 l7 6 l-8 3', w: 1.1, k: 'accent' },
    ],
    notes: [[8, 46, 'DO NOT BLINK', -6], [236, 270, 'it was', -4], [226, 290, 'over there', -4]],
  },

  // ------------------------------------------------------------------ the Snatcher: long arms out of a ceiling vent
  snatcher: {
    body: [
      // duct opening in the ceiling + the grate hanging open from its hinge
      'M104 18 L224 18 L224 48 L104 48 Z',
      'M104 48 L112 50 L92 128 L80 124 Z',
      // pale crown peeking out
      'M138 48 C142 38 156 33 166 34 C178 35 188 40 192 48 Z',
      // left arm: shoulder in the duct, elbow out, wrist bent, long fingers
      'M134 46 C124 62 112 80 104 100 C100 112 100 124 104 136 C108 152 108 170 104 186 L98 204 L92 224 L97 226 L102 210 L102 232 L108 232 '
      + 'L108 212 L113 230 L118 228 L114 206 L118 188 C122 170 122 150 118 134 C114 120 116 108 122 98 C130 84 140 66 148 48 Z',
      // right arm, longer, reaching down and out
      'M186 48 C198 62 210 78 220 96 C228 110 232 126 232 142 C232 160 236 178 244 194 L254 212 L264 228 L259 232 L250 220 L254 240 L248 242 '
      + 'L242 224 L240 242 L234 240 L234 220 L228 202 C220 186 216 168 216 150 C216 132 212 118 204 104 C196 90 186 72 174 50 Z',
    ],
    strokes: [
      // ceiling, opening, hanging grate
      { d: 'M8 18 L312 18', w: 1.2, k: 'detail', op: 0.8 },
      { d: 'M104 18 L224 18 L224 48 L104 48 Z', k: 'fill', op: 0.92 },
      { d: 'M104 48 L112 50 L92 128 L80 124 Z', w: 1.5 },
      { d: 'M106 58 L94 104 M100 54 L88 100 M103 70 L90 116', w: 0.9, k: 'detail' },
      { d: 'M98 50 L106 50 M100 60 L90 58', w: 0.8, k: 'detail', op: 0.6 },
      // the crown in the dark
      { d: 'M138 48 C142 38 156 33 166 34 C178 35 188 40 192 48', w: 1.4 },
      { d: 'M150 46 C156 42 166 41 174 44', w: 0.8, k: 'detail', op: 0.7 },
      // arms
      { d: 'M134 46 C124 62 112 80 104 100 C100 112 100 124 104 136 C108 152 108 170 104 186 L98 204 L92 224 M97 226 L102 210 L102 232 M108 232 L108 212 L113 230 M118 228 L114 206 L118 188 C122 170 122 150 118 134 C114 120 116 108 122 98 C130 84 140 66 148 48', w: 1.6 },
      { d: 'M186 48 C198 62 210 78 220 96 C228 110 232 126 232 142 C232 160 236 178 244 194 L254 212 L264 228 M259 232 L250 220 L254 240 M248 242 L242 224 L240 242 M234 240 L234 220 L228 202 C220 186 216 168 216 150 C216 132 212 118 204 104 C196 90 186 72 174 50', w: 1.6 },
      // knuckles, elbows, tendons
      { d: 'M102 134 q8 4 16 0 M216 140 q8 4 16 -1 M104 186 q6 2 13 1 M230 200 q7 1 14 -3 M110 104 C114 116 114 126 112 136 M208 106 C214 118 218 130 220 142', w: 0.8, k: 'detail' },
      { d: 'M106 136 C110 152 110 170 106 186 L100 204 C108 188 112 170 112 152 C112 144 110 138 106 136 Z M136 50 C128 64 118 80 110 98 C120 84 130 68 140 50 Z', k: 'shade', op: 0.8 },
      { d: 'M220 144 C220 162 224 180 232 196 L242 212 C236 196 230 178 228 160 Z M190 52 C200 66 208 80 216 94 C210 78 200 64 192 50 Z', k: 'shade', op: 0.7 },
      // falling dust
      { d: 'M160 62 l0.1 0 M166 80 l0.1 0 M156 100 l0.1 0 M170 118 l0.1 0 M162 140 l0.1 0 M176 96 l0.1 0 M150 128 l0.1 0 M168 168 l0.1 0 M158 190 l0.1 0', w: 2.6 },
      { d: 'M160 54 L160 66 M166 72 L166 84', w: 0.6, k: 'detail', op: 0.5 },
      // floor with drag marks
      { d: 'M14 280 C110 278 220 280 306 277', w: 0.9, k: 'detail', op: 0.6 },
      { d: 'M150 288 C190 285 230 286 290 283 M156 294 C196 291 236 292 296 289', w: 0.9, k: 'detail', op: 0.6 },
      // red pencil: arrow to the opening
      { d: 'M286 104 C282 80 268 60 234 42', w: 1.1, k: 'accent' },
      { d: 'M238 36 l-6 6 l8 3', w: 1.1, k: 'accent' },
    ],
    notes: [[258, 128, 'VENTS', -8], [22, 268, 'drag marks', -3]],
  },
};

export type SketchMode = 'sketch' | 'silhouette';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** a complete <svg> for one monster (ids prefixed per kind + mode so several can coexist) */
export function sketchSvg(kind: MonsterKind, mode: SketchMode, opts: { width?: number; font?: string } = {}): string {
  const s = SKETCHES[kind];
  const id = `fgs-${kind}-${mode}`;
  const font = opts.font ?? `'Caveat', 'Segoe Print', 'Comic Sans MS', cursive`;
  const defs = `<defs>`
    + `<filter id="${id}-rough" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="${kind.length * 7}" result="n"/>`
    + `<feDisplacementMap in="SourceGraphic" in2="n" scale="2.4" xChannelSelector="R" yChannelSelector="G"/></filter>`
    + `<filter id="${id}-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5"/></filter>`
    + `<pattern id="${id}-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(38)"><line x1="0" y1="0" x2="0" y2="5" stroke="#2b2924" stroke-width="1.1" stroke-opacity="0.55"/></pattern>`
    + `</defs>`;
  const wAttr = opts.width ? ` width="${opts.width}" height="${Math.round((opts.width * H) / W)}"` : '';
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"${wAttr} role="img" aria-label="${kind} ${mode}">${defs}`;
  if (mode === 'silhouette') {
    const shapes = s.body.map((d) => `<path d="${d}"/>`).join('');
    return `${head}<g filter="url(#${id}-blur)" fill="#15140f" fill-opacity="0.82">${shapes}</g>`
      + `<g fill="#15140f" fill-opacity="0.55">${shapes}</g>`
      + `<text x="${W / 2}" y="${H / 2 + 26}" text-anchor="middle" font-family="${esc(font)}" font-size="86" fill="#a8241c" fill-opacity="0.85" transform="rotate(-8 ${W / 2} ${H / 2})">?</text></svg>`;
  }
  const out: string[] = [];
  // paper-white underlay keeps the hatching readable over the page texture
  out.push(`<g fill="#f3eddc" fill-opacity="0.55">${s.body.map((d) => `<path d="${d}"/>`).join('')}</g>`);
  const shades = s.strokes.filter((x) => x.k === 'shade').map((x) => `<path d="${x.d}" fill="url(#${id}-hatch)" opacity="${x.op ?? 0.8}"/>`).join('');
  out.push(`<g>${shades}</g>`);
  const lines = s.strokes.filter((x) => x.k !== 'shade' && x.k !== 'accent').map((x) => {
    if (x.k === 'fill') return `<path d="${x.d}" fill="#1d1c18" opacity="${x.op ?? 0.9}"/>`;
    const col = x.k === 'eye' ? '#7a4fc0' : '#26241f';
    const w = x.w ?? (x.k === 'detail' ? 1 : 1.6);
    return `<path d="${x.d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" opacity="${x.op ?? (x.k === 'detail' ? 0.8 : 0.92)}"/>`;
  }).join('');
  out.push(`<g filter="url(#${id}-rough)">${lines}</g>`);
  const accents = s.strokes.filter((x) => x.k === 'accent').map((x) =>
    `<path d="${x.d}" fill="none" stroke="#b3271d" stroke-width="${x.w ?? 1.1}" stroke-linecap="round" stroke-linejoin="round" opacity="${x.op ?? 0.85}"/>`).join('');
  const notes = s.notes.map(([x, y, t, r]) =>
    `<text x="${x}" y="${y}" font-family="${esc(font)}" font-size="17" fill="#b3271d" fill-opacity="0.9"${r ? ` transform="rotate(${r} ${x} ${y})"` : ''}>${esc(t)}</text>`).join('');
  out.push(`<g filter="url(#${id}-rough)">${accents}</g>${notes}`);
  return `${head}${out.join('')}</svg>`;
}
