import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../web/xzg_image_loader.js', import.meta.url), 'utf8');
const start = source.indexOf('    let listFlipTimer = null;');
const end = source.indexOf('    const redraw =', start);
const tailStart = source.indexOf('        grid.appendChild(frag);', end);
const tailEnd = source.indexOf('\n    };', tailStart);
assert.ok(start >= 0 && end > start && tailStart > end && tailEnd > tailStart);
let cards = [];
let nextTimer = 0;
const timers = new Map();
const grid = {
    style: {}, offsetWidth: 100,
    querySelectorAll: () => cards,
    appendChild(fragment) { cards = fragment; },
};
const createCard = () => ({ style: {} });
const harness = new Function('grid', 'setTimeout', 'clearTimeout', 'applyRandomFlip', `
    ${source.slice(start, end)}
    return {
        rebuild(listChanged, frag) { ${source.slice(tailStart, tailEnd)} },
        clear: clearListFlip,
    };
`)(grid, callback => { timers.set(++nextTimer, callback); return nextTimer; },
    id => timers.delete(id), () => {});

// setNameList's callback redraws first, then the upload handler forces another redraw.
const firstCards = [createCard(), createCard()];
harness.rebuild(true, firstCards);
assert.match(firstCards[0].style.animation, /xzgCardFlipIn/);
const replacementCards = [createCard(), createCard()];
harness.rebuild(false, replacementCards);
assert.match(replacementCards[0].style.animation, /xzgCardFlipIn/);
assert.equal(firstCards[0].style.animation, '');
assert.equal(timers.size, 1);
// Further rebuilds during playback must also retain the effect.
const finalCards = [createCard(), createCard()];
harness.rebuild(false, finalCards);
assert.match(finalCards[1].style.animation, /xzgCardFlipIn/);
[...timers.values()][0]();
assert.equal(finalCards[1].style.animation, '');
assert.equal(grid.style.perspective, '');
// An ordinary redraw after completion should not start an animation.
const idleCards = [createCard(), createCard()];
harness.rebuild(false, idleCards);
assert.equal(idleCards[0].style.animation, undefined);
harness.clear();
console.log('Image list flip survives consecutive grid rebuilds.');
