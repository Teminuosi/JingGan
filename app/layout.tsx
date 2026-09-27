import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '镜感｜视频 DNA 提示词工作台',
  description: '用 Gemini 拆解参考视频，并生成可替换角色、对白与场景的视频生成提示词。',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  openGraph: {
    title: '镜感｜视频 DNA 提示词工作台',
    description: '保留它的感觉，换成你的故事。',
    type: 'website',
    images: [{ url: '/og.png', width: 1731, height: 909, alt: '镜感视频 DNA 提示词工作台' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '镜感｜视频 DNA 提示词工作台',
    description: '保留它的感觉，换成你的故事。',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
