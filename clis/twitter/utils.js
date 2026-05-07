import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArgumentError } from '@jackwener/opencli/errors';

/**
 * Public read-only Twitter web bearer token used by the GraphQL endpoints we
 * call from the page context. This is the same token the Twitter web app
 * itself uses; centralising it here keeps the 12+ GraphQL adapters from
 * drifting when X rotates the value.
 */
export const TWITTER_BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

/** File-input selector used by the X /compose/post route for both posts and replies. */
export const COMPOSER_FILE_INPUT_SELECTOR = 'input[type="file"][data-testid="fileInput"]';

/** Image formats the X composer accepts. */
export const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** 20 MB hard cap. Twitter allows ~5MB images / 15MB GIFs; 20MB is a safety net. */
export const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;

const CONTENT_TYPE_TO_EXTENSION = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
};

/**
 * Validate a single image path. Throws {@link ArgumentError} on bad input
 * (typed input failure surfaces before any browser interaction).
 *
 * @param {string} imagePath - Local filesystem path, may be relative.
 * @returns {string} Absolute resolved path.
 */
export function resolveImagePath(imagePath) {
    const absPath = path.resolve(imagePath);
    if (!fs.existsSync(absPath)) {
        throw new ArgumentError(`Image file not found: ${absPath}`);
    }
    const ext = path.extname(absPath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
        throw new ArgumentError(`Unsupported image format "${ext}". Supported: jpg, jpeg, png, gif, webp`);
    }
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_IMAGE_SIZE_BYTES) {
        throw new ArgumentError(`Image too large: ${(stat.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_IMAGE_SIZE_BYTES / 1024 / 1024} MB)`);
    }
    return absPath;
}

/**
 * Resolve the file extension to use when persisting a remote image: prefer
 * Content-Type, fall back to URL pathname.
 */
export function resolveImageExtension(url, contentType) {
    const normalizedContentType = (contentType || '').split(';')[0].trim().toLowerCase();
    if (normalizedContentType && CONTENT_TYPE_TO_EXTENSION[normalizedContentType]) {
        return CONTENT_TYPE_TO_EXTENSION[normalizedContentType];
    }
    try {
        const pathname = new URL(url).pathname;
        const ext = path.extname(pathname).toLowerCase();
        if (SUPPORTED_IMAGE_EXTENSIONS.has(ext))
            return ext;
    } catch {
        // Fall through to the final error below.
    }
    throw new ArgumentError(
        `Unsupported remote image format "${normalizedContentType || 'unknown'}". Supported: jpg, jpeg, png, gif, webp`,
    );
}

/**
 * Download a remote image to a per-call tmp directory. Returns the absolute
 * path on success. Caller owns the tmp dir and must clean it up. Throws
 * {@link ArgumentError} on bad input or download failure.
 *
 * @returns {Promise<{ absPath: string, cleanupDir: string }>}
 */
export async function downloadRemoteImage(imageUrl) {
    let parsed;
    try {
        parsed = new URL(imageUrl);
    } catch {
        throw new ArgumentError(`Invalid image URL: ${imageUrl}`);
    }
    if (!/^https?:$/.test(parsed.protocol)) {
        throw new ArgumentError(`Unsupported image URL protocol: ${parsed.protocol}`);
    }
    const response = await fetch(imageUrl);
    if (!response.ok) {
        throw new ArgumentError(`Image download failed: HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length') || '0');
    if (contentLength > MAX_IMAGE_SIZE_BYTES) {
        throw new ArgumentError(`Image too large: ${(contentLength / 1024 / 1024).toFixed(1)} MB (max ${MAX_IMAGE_SIZE_BYTES / 1024 / 1024} MB)`);
    }
    const ext = resolveImageExtension(imageUrl, response.headers.get('content-type'));
    const cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-twitter-'));
    const absPath = path.join(cleanupDir, `image${ext}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_SIZE_BYTES) {
        fs.rmSync(cleanupDir, { recursive: true, force: true });
        throw new ArgumentError(`Image too large: ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB (max ${MAX_IMAGE_SIZE_BYTES / 1024 / 1024} MB)`);
    }
    fs.writeFileSync(absPath, buffer);
    return { absPath, cleanupDir };
}

/**
 * Attach a single image to the current /compose/post composer. Tries the
 * native CDP file-input bridge first; falls back to a base64 DataTransfer
 * shim if the bridge is missing or rejects with "Unknown action" /
 * "not supported". Throws on hard failures.
 *
 * After upload it polls the DOM briefly to confirm the preview thumbnail
 * actually rendered — without this, a 200 from setFileInput could mask a
 * silent-no-attachment post.
 *
 * @param {object} page - OpenCLI page handle.
 * @param {string} absImagePath - Already-validated absolute path.
 * @param {string} [fileInputSelector] - Override (post.js historically used
 *   the same selector; default matches the X composer route).
 */
export async function attachComposerImage(page, absImagePath, fileInputSelector = COMPOSER_FILE_INPUT_SELECTOR) {
    let uploaded = false;
    if (page.setFileInput) {
        try {
            await page.setFileInput([absImagePath], fileInputSelector);
            uploaded = true;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('Unknown action') && !msg.includes('not supported')) {
                throw new Error(`Image upload failed: ${msg}`);
            }
            // setFileInput not supported by extension — fall through to base64 fallback.
        }
    }
    if (!uploaded) {
        const ext = path.extname(absImagePath).toLowerCase();
        const mimeType = ext === '.png'
            ? 'image/png'
            : ext === '.gif'
                ? 'image/gif'
                : ext === '.webp'
                    ? 'image/webp'
                    : 'image/jpeg';
        const base64 = fs.readFileSync(absImagePath).toString('base64');
        if (base64.length > 500_000) {
            console.warn(`[warn] Image base64 payload is ${(base64.length / 1024 / 1024).toFixed(1)}MB. ` +
                'This may fail with the browser bridge. Update the extension to v1.6+ for CDP-based upload, ' +
                'or compress the image before attaching.');
        }
        const upload = await page.evaluate(`
      (() => {
        const input = document.querySelector(${JSON.stringify(fileInputSelector)});
        if (!input) return { ok: false, error: 'No file input found on page' };

        const binary = atob(${JSON.stringify(base64)});
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const dt = new DataTransfer();
        const blob = new Blob([bytes], { type: ${JSON.stringify(mimeType)} });
        dt.items.add(new File([blob], ${JSON.stringify(path.basename(absImagePath))}, { type: ${JSON.stringify(mimeType)} }));

        Object.defineProperty(input, 'files', { value: dt.files, writable: false });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true };
      })()
    `);
        if (!upload?.ok) {
            throw new Error(`Image upload failed: ${upload?.error ?? 'unknown error'}`);
        }
    }
    await page.wait(2);
    const uploadState = await page.evaluate(`
    (() => {
      const previewCount = document.querySelectorAll(
        '[data-testid="attachments"] img, [data-testid="attachments"] video, [data-testid="tweetPhoto"]'
      ).length;
      const hasMedia = previewCount > 0
        || !!document.querySelector('[data-testid="attachments"]')
        || !!Array.from(document.querySelectorAll('button,[role="button"]')).find((el) =>
          /remove media|remove image|remove/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''))
        );
      return { ok: hasMedia, previewCount };
    })()
  `);
    if (!uploadState?.ok) {
        throw new Error('Image upload failed: preview did not appear.');
    }
}

export const __test__ = {
    resolveImagePath,
    resolveImageExtension,
    downloadRemoteImage,
    attachComposerImage,
};
