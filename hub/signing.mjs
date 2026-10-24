// Packaging and signing Pardeh for a Samsung TV, and getting a Samsung certificate for a TV,
// with Node's built-in crypto only (no Tizen Studio, no npm packages).
//
// A .wgt is a zip with two XML signatures (W3C widget digital signatures): author-signature.xml
// covers the app's files, signature1.xml (the distributor) covers those plus the author signature.
// The format below matches what Tizen Studio writes, byte for byte.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const SAMSUNG_CA = 'https://svdca.samsungqbe.com/apis/v3/';

// SHA-512 of the canonical <Object Id="prop"> each signature ends with. It only depends on the
// signature's role, so it's the same in every package.
const PROP_DIGEST = {
    AuthorSignature: 'aXbSAVgmAz0GsBUeZ1UmNDRrxkWhDUVGb45dZcNRq429wX3X+x6kaXT3NdNDTSNVTU+ypkysPMGvQY10fG1EWQ==',
    DistributorSignature: '/r5npk2VVA46QFJnejgONBEh4BWtjrtu9x/IFeLksjWyGmB/cMWKSJWQl7aU3YRQRZ3AesG8gF7qGyvKX9Snig=='
};

const wrap76 = (b64) => b64.replace(/(.{76})/g, '$1\n');

function propObject(id) {
    const role = id === 'AuthorSignature' ? 'author' : 'distributor';
    return '<Object Id="prop"><SignatureProperties xmlns:dsp="http://www.w3.org/2009/xmldsig-properties">' +
        `<SignatureProperty Id="profile" Target="#${id}"><dsp:Profile URI="http://www.w3.org/ns/widgets-digsig#profile"></dsp:Profile></SignatureProperty>` +
        `<SignatureProperty Id="role" Target="#${id}"><dsp:Role URI="http://www.w3.org/ns/widgets-digsig#role-${role}"></dsp:Role></SignatureProperty>` +
        `<SignatureProperty Id="identifier" Target="#${id}"><dsp:Identifier></dsp:Identifier></SignatureProperty>` +
        '</SignatureProperties></Object>';
}

function reference(uri, digest, transform) {
    return `<Reference URI="${uri}">\n` +
        (transform ? '<Transforms>\n<Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"></Transform>\n</Transforms>\n' : '') +
        '<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha512"></DigestMethod>\n' +
        `<DigestValue>${wrap76(digest)}</DigestValue>\n</Reference>\n`;
}

export function signedInfo(id, files) {
    let refs = '';
    for (const f of files) refs += reference(encodeURIComponent(f.name), crypto.createHash('sha512').update(f.data).digest('base64'));
    refs += reference('#prop', PROP_DIGEST[id], true);
    return '<SignedInfo>\n' +
        '<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod>\n' +
        '<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha512"></SignatureMethod>\n' +
        refs + '</SignedInfo>';
}

// Exclusive canonical form of the <SignedInfo> above: it is already canonical apart from the
// namespace it inherits from <Signature>, which canonicalization moves onto it.
export const canonical = (info) => info.replace('<SignedInfo>', `<SignedInfo xmlns="${DSIG}">`);

const pemBody = (pem) => pem.replace(/-----[^-]+-----|\s/g, '');

// files: [{ name, data }] sorted by name; key: { privateKey (PEM), chain: [leaf PEM, CA PEM] }
export function signature(id, files, key) {
    const info = signedInfo(id, files);
    const value = crypto.sign('sha512', Buffer.from(canonical(info)), key.privateKey).toString('base64');
    const certs = key.chain.map((c) => `<X509Certificate>\n${wrap76(pemBody(c))}\n</X509Certificate>\n`).join('');
    return Buffer.from(`<Signature xmlns="${DSIG}" Id="${id}">\n${info}\n<SignatureValue>\n${wrap76(value)}\n</SignatureValue>\n` +
        `<KeyInfo>\n<X509Data>\n${certs}</X509Data>\n</KeyInfo>\n${propObject(id)}\n</Signature>\n`);
}

// The app folder's files (hidden files and old signatures left out), sorted like Tizen Studio does.
export function appFiles(dir) {
    const out = [];
    const walk = (rel) => {
        for (const name of fs.readdirSync(path.join(dir, rel))) {
            const r = rel ? `${rel}/${name}` : name;
            if (name.startsWith('.') || /^(author-signature|signature\d*)\.xml$/.test(r)) continue;
            if (fs.statSync(path.join(dir, r)).isDirectory()) walk(r); else out.push({ name: r, data: fs.readFileSync(path.join(dir, r)) });
        }
    };
    walk('');
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function signPackage(files, author, distributor) {
    const authorSig = { name: 'author-signature.xml', data: signature('AuthorSignature', files, author) };
    const withAuthor = [authorSig, ...files].sort((a, b) => (a.name < b.name ? -1 : 1));
    const distSig = { name: 'signature1.xml', data: signature('DistributorSignature', withAuthor, distributor) };
    return zip([...withAuthor, distSig]);
}

// ---------- zip (deflate), enough for a .wgt ----------
const CRC = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
});

function crc32(buf) {
    let c = -1;
    for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

export function zip(files) {
    const local = [], central = [];
    let offset = 0;
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
        const name = Buffer.from(f.name, 'utf8'), packed = zlib.deflateRawSync(f.data), crc = crc32(f.data);
        const h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
        h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(packed.length, 18); h.writeUInt32LE(f.data.length, 22); h.writeUInt16LE(name.length, 26);
        local.push(h, name, packed);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
        c.writeUInt16LE(8, 10); c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16);
        c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28);
        c.writeUInt32LE(offset, 42);
        central.push(c, name);
        offset += h.length + name.length + packed.length;
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, cd, end]);
}

// ---------- certificate requests (PKCS#10), built by hand in DER ----------
function derLen(n) {
    if (n < 128) return Buffer.from([n]);
    const b = [];
    for (; n; n >>>= 8) b.unshift(n & 255);
    return Buffer.from([0x80 | b.length, ...b]);
}
const der = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]); };
const seq = (...p) => der(0x30, ...p);
const set = (...p) => der(0x31, ...p);
function oid(s) {
    const n = s.split('.').map(Number), out = [40 * n[0] + n[1]];
    for (const v of n.slice(2)) {
        const b = [v & 127];
        for (let x = v >>> 7; x; x >>>= 7) b.unshift((x & 127) | 128);
        out.push(...b);
    }
    return der(0x06, Buffer.from(out));
}

// subject: { cn, email }; deviceIds: the TVs a distributor certificate is for.
export function certificateRequest(subject, privateKey, deviceIds) {
    const rdn = [set(seq(oid('2.5.4.3'), der(0x0c, Buffer.from(subject.cn))))];
    if (subject.email) rdn.push(set(seq(oid('1.2.840.113549.1.9.1'), der(0x16, Buffer.from(subject.email)))));
    let attributes = der(0xa0);
    if (deviceIds) {
        const uris = ['URN:tizen:packageid=', ...deviceIds.map((d) => `URN:tizen:deviceid=${d}`)].map((u) => der(0x86, Buffer.from(u)));
        const altNames = seq(oid('2.5.29.17'), der(0x04, seq(...uris)));
        attributes = der(0xa0, seq(oid('1.2.840.113549.1.9.14'), set(seq(altNames))));
    }
    const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const info = seq(der(0x02, Buffer.from([0])), seq(...rdn), spki, attributes);
    const sig = crypto.sign('sha512', info, privateKey);
    const csr = seq(info, seq(oid('1.2.840.113549.1.1.13'), der(0x05)), der(0x03, Buffer.from([0]), sig));
    return `-----BEGIN CERTIFICATE REQUEST-----\n${csr.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE REQUEST-----\n`;
}

// ---------- Samsung certificates ----------
// What Tizen Studio's Certificate Manager does for "Samsung → TV": with a Samsung account token,
// Samsung signs an author certificate and a distributor certificate that lists the TV's id (DUID).
// The distributor answer is the device profile ("permit to install") the TV needs as well; the
// certificate is inside it.

// Samsung account sign-in as Certificate Manager does it; the browser comes back to this address.
export const SIGNIN_PORT = 4794;
export const SIGNIN_URL = 'https://account.samsung.com/mobile/account/check.do?serviceID=v285zxnl3h&actionID=StartOAuth2' +
    `&accessToken=Y&redirect_uri=http://localhost:${SIGNIN_PORT}/signin/callback`;

async function samsungRequest(kind, access, csr, extra = {}) {
    const form = new FormData();
    form.append('access_token', access.accessToken);
    form.append('user_id', access.userId);
    form.append('platform', 'VD');
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    form.append('csr', new Blob([csr], { type: 'application/octet-stream' }), `${kind.slice(0, -1)}.csr`);
    const res = await fetch(SAMSUNG_CA + kind, { method: 'POST', body: form });
    const text = await res.text();
    if (!res.ok) throw new Error(`Samsung refused the ${kind.slice(0, -1)} certificate (${res.status}): ${text.slice(0, 300)}`);
    return text;
}

const toPem = (b64) => `-----BEGIN CERTIFICATE-----\n${b64.replace(/\s/g, '').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;

// A certificate from Samsung's answer: a PEM block, or the <Certificate> of a device profile.
export function certificateFrom(text) {
    const pem = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
    if (pem) return pem[0] + '\n';
    const field = text.match(/<Certificate>\s*([A-Za-z0-9+/=\s]+?)\s*<\/Certificate>/);
    return field ? toPem(field[1]) : null;
}

const CA_DIR = new URL('./samsung-ca/', import.meta.url);

// access: { accessToken, userId, email }. Returns everything installing needs, as text (PEM / XML).
export async function createSamsungCertificate(access, duid) {
    const keyOpts = { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } };
    const authorKey = crypto.generateKeyPairSync('rsa', keyOpts).privateKey;
    const distKey = crypto.generateKeyPairSync('rsa', keyOpts).privateKey;
    const authorText = await samsungRequest('authors', access, certificateRequest({ cn: 'Pardeh' }, authorKey));
    const profile = await samsungRequest('distributors', access,
        certificateRequest({ cn: 'TizenSDK', email: access.email }, distKey, [duid]),
        { privilege_level: 'Public', developer_type: 'Individual' });
    const authorCert = certificateFrom(authorText), distCert = certificateFrom(profile);
    if (!authorCert || !distCert) throw new Error(`Samsung's answer had no certificate in it: ${(authorCert ? profile : authorText).slice(0, 200)}`);
    return {
        duid,
        author: { privateKey: authorKey, chain: [authorCert, fs.readFileSync(new URL('author-ca.cer', CA_DIR), 'utf8')] },
        distributor: { privateKey: distKey, chain: [distCert, fs.readFileSync(new URL('distributor-public-ca.cer', CA_DIR), 'utf8')] },
        deviceProfile: profile.includes('<Profile') ? profile : null,
        created: new Date().toISOString()
    };
}
