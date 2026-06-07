declare module "*.css" {
  const content: { [className: string]: string };
  export default content;
}

declare module "katex/contrib/auto-render" {
  interface AutoRenderOptions {
    delimiters?: { left: string; right: string; display: boolean }[];
    ignoredTags?: string[];
    throwOnError?: boolean;
  }
  const renderMathInElement: (el: HTMLElement, options?: AutoRenderOptions) => void;
  export default renderMathInElement;
}
