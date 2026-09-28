// Deterministic synthetic face embeddings (same generator as
// tests/ai/dbscan.test.js): unit vectors around `k` identity centres plus
// strangers; `noise` controls how many pairs straddle eps. Seeded LCG, so
// every run and every machine produces the same data.

export function synthFaces(n, { k = 8, dim = 64, seed = 1, noise = 0.12, strangers = 0.15 } = {}) {
    let s = seed >>> 0;
    const rnd = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    const unit = (a) => {
        let t = 0;
        for (const v of a) t += v * v;
        t = Math.sqrt(t);
        return a.map((v) => v / t);
    };
    const centres = Array.from({ length: k }, () =>
        unit(Float32Array.from({ length: dim }, gauss)),
    );
    return Array.from({ length: n }, (_, i) => {
        const base =
            rnd() < strangers
                ? unit(Float32Array.from({ length: dim }, gauss))
                : centres[Math.floor(rnd() * k)];
        const e = unit(Float32Array.from(base, (v) => v + gauss() * noise));
        return { id: i + 1, embedding: e, qualityScore: i % 5 === 0 ? null : 0.3 + rnd() };
    });
}

/** Pack faces the way the scan runner does: {data, n, dim, weights}. */
export function packFaces(faces) {
    const n = faces.length;
    const dim = n ? faces[0].embedding.length : 0;
    const data = new Float32Array(n * dim);
    for (let i = 0; i < n; i++) data.set(faces[i].embedding, i * dim);
    const weights = Float64Array.from(faces, (f) =>
        Number.isFinite(f.qualityScore) ? f.qualityScore : Number.NaN,
    );
    return { data, n, dim, weights };
}
