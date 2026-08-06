/** Copis 使用自有 Prompt、Context、Memory 和 Skills，不加载 Pi 的指令文件。 */
export function createCopisResourceLoaderOptions(): { noContextFiles: true } {
  return { noContextFiles: true }
}
