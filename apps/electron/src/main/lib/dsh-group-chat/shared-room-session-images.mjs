// RC2 共享群只向模型开放当前轮的内存图片引用，不挂载会落盘的附件插件。
const MAX_BATCH_BYTES = 20 * 1024 * 1024;
export function roomImageStore(attachment, local, loadSharp) {
  const images = new Map();
  class MemoryAttachments extends attachment.AttachmentStore {
    imageLimits = { maxImageBytes: MAX_BATCH_BYTES, maxImagesPerMessage: 20, maxMessageImageBytes: MAX_BATCH_BYTES,
      maxImagePixels: local.DEFAULT_MAX_IMAGE_PIXELS, maxImageDimension: local.DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] };

    async saveImages(inputs) {
      this.validateImageBatch(inputs);
      if (!inputs.length) return [];
      // Rust 内置代理请求上限 8 MiB：为 base64、文本和协议封装预留空间。
      const maxBytes = Math.min(1024 * 1024, Math.floor(4 * 1024 * 1024 / inputs.length));
      const refs = [];
      for (const input of inputs) {
        // 复用 RC2 解码检查、去元数据和压缩，只做内存准备；逐张处理限制解码峰值。
        const item = await local.prepareImageFile(input, this.imageLimits, {
          maxPixels: local.DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS, maxDimension: local.DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION, maxBytes,
        });
        if (item.data.byteLength > maxBytes) throw new Error('图片压缩后仍超过模型请求上限');
        const { hasAlpha } = await loadSharp()(item.data).metadata();
        images.set(item.ref.attachmentId, { ...item, hasAlpha });
        refs.push(item.ref);
      }
      return refs;
    }

    async readImage(ref, signal) {
      signal?.throwIfAborted();
      const stored = images.get(ref.attachmentId);
      if (!stored) throw new Error('本轮图片不可用');
      return stored;
    }

    async readImageRequest(ref, target, signal) {
      const { data, ref: saved, hasAlpha } = await this.readImage(ref, signal);
      if (saved.width > target.width || saved.height > target.height || data.byteLength > target.maxBytes) throw new Error('图片不满足模型输入限制');
      return { variantId: local.requestImageVariantId(saved, target), attachment: saved, data,
        mediaType: saved.mediaType, width: saved.width, height: saved.height, bytes: data.byteLength,
        depth: 'uchar', space: 'srgb', hasAlpha };
    }
  }
  return { plugin: MemoryAttachments, clear: () => images.clear() };
}
