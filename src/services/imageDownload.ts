import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as crypto from 'crypto';
import { ImageDownloadCache } from '../models';
import { assertSafeFetchUrl } from '../utils/ssrfProtection';
import logger, { formatError } from '../utils/logger';

/**
 * 安全下载图片并返回 base64 字符串。
 * - SSRF 防护：任何请求前先经 assertSafeFetchUrl 校验。
 * - 落库缓存：按 urlHash 命中则直接返回，避免重复拉取 OpenAI 图片。
 * - 重试：默认 3 次（延迟 1s / 3s / 6s）。
 * - 体积上限：10 MB。
 */
const IMAGE_RETRY_DELAYS_MS = [1000, 3000, 6000];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export async function downloadImageAsBase64(url: string, logPrefix = 'imageDownload'): Promise<string | null> {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl) {
        return null;
    }

    // SSRF protection: reject unsafe URLs before any request.
    try {
        await assertSafeFetchUrl(normalizedUrl);
    } catch (error: any) {
        logger.warn(`${logPrefix} Image URL rejected by SSRF protection`, formatError(error));
        return null;
    }

    const urlHash = crypto.createHash('sha256').update(normalizedUrl).digest('hex');
    try {
        const cache = await ImageDownloadCache.findOne({ where: { urlHash } });
        if (cache?.imageBase64) {
            await cache.update({
                hitCount: (cache.hitCount || 0) + 1,
                lastAccessedAt: new Date()
            });
            logger.info(`${logPrefix} Image cache hit`, { urlHash });
            return cache.imageBase64;
        }
    } catch (error: any) {
        logger.warn(`${logPrefix} Failed to read image cache`, formatError(error));
    }

    const proxyUrl =
        process.env.ALL_PROXY ||
        process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY ||
        '';

    for (let attempt = 1; attempt <= IMAGE_RETRY_DELAYS_MS.length + 1; attempt++) {
        try {
            logger.info(`${logPrefix} Downloading image (attempt ${attempt}/${IMAGE_RETRY_DELAYS_MS.length + 1})`, { url: normalizedUrl.substring(0, 80) + '...' });

            const axiosConfig: any = {
                url: normalizedUrl,
                method: 'GET',
                responseType: 'arraybuffer',
                timeout: 30000,
                maxContentLength: MAX_IMAGE_BYTES,
                maxBodyLength: MAX_IMAGE_BYTES,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; CopyTrader/1.0)'
                }
            };

            if (proxyUrl) {
                const agent = new HttpsProxyAgent(proxyUrl);
                axiosConfig.httpsAgent = agent;
                axiosConfig.httpAgent = agent;
            }

            const response = await axios(axiosConfig);
            const buffer = Buffer.from(response.data);
            if (buffer.length > MAX_IMAGE_BYTES) {
                throw new Error(`Image download exceeds maximum allowed size (${buffer.length} bytes)`);
            }
            const base64 = buffer.toString('base64');
            const mimeTypeHeader = response.headers?.['content-type'];
            const mimeType = typeof mimeTypeHeader === 'string' ? mimeTypeHeader.split(';')[0] : null;
            if (mimeType && !mimeType.startsWith('image/')) {
                throw new Error(`Refused non-image response content-type: ${mimeType}`);
            }

            logger.info(`${logPrefix} Image downloaded successfully`, { sizeBytes: buffer.length });
            try {
                await ImageDownloadCache.upsert({
                    url: normalizedUrl,
                    urlHash,
                    imageBase64: base64,
                    mimeType,
                    sizeBytes: buffer.length,
                    hitCount: 0,
                    lastAccessedAt: new Date()
                });
            } catch (cacheError: any) {
                logger.warn(`${logPrefix} Failed to write image cache`, formatError(cacheError));
            }
            return base64;

        } catch (error: any) {
            logger.warn(`${logPrefix} Image download attempt ${attempt} failed`, formatError(error));
            if (attempt <= IMAGE_RETRY_DELAYS_MS.length) {
                await sleep(IMAGE_RETRY_DELAYS_MS[attempt - 1]);
            }
        }
    }

    logger.error(`${logPrefix} All image download attempts failed`, { url: normalizedUrl.substring(0, 80) + '...' });
    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}