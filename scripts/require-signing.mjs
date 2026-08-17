const certificate = process.env.WIN_CSC_LINK ?? process.env.CSC_LINK;
const password = process.env.WIN_CSC_KEY_PASSWORD ?? process.env.CSC_KEY_PASSWORD;

if (!certificate || !password) {
  console.error("拒绝生成发布安装包：请设置 WIN_CSC_LINK/CSC_LINK 和 WIN_CSC_KEY_PASSWORD/CSC_KEY_PASSWORD。局部验收可显式运行 npm run dist:win:unsigned。");
  process.exit(1);
}
