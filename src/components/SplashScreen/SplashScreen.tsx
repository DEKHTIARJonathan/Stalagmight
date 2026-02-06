interface SplashScreenProps {
  visible: boolean;
  onTransitionEnd: () => void;
}

export default function SplashScreen({ visible, onTransitionEnd }: SplashScreenProps) {
  return (
    <div
      data-testid="splash-screen"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center"
      style={{
        backgroundColor: 'var(--cc-background)',
        opacity: visible ? 1 : 0,
        transition: 'opacity 300ms ease-out',
        pointerEvents: visible ? 'auto' : 'none',
      }}
      onTransitionEnd={(e) => {
        if (e.propertyName === 'opacity' && !visible) {
          onTransitionEnd();
        }
      }}
    >
      {/* Stacked lockup: logo mark + text */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 1000 1200"
        role="img"
        aria-label="StalagMight"
        style={{ width: 220, height: 264 }}
      >
        <g transform="translate(0 40) scale(0.74)">
          <defs>
            <radialGradient id="splash-bg" cx="35%" cy="30%" r="85%">
              <stop offset="0" stopColor="#3A251A" />
              <stop offset="1" stopColor="#1A120B" />
            </radialGradient>
            <linearGradient id="splash-accent" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#F3E8D8" />
              <stop offset="1" stopColor="#C1A07A" />
            </linearGradient>
            <clipPath id="splash-clip">
              <circle cx="512" cy="512" r="310" />
            </clipPath>
          </defs>

          <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#splash-bg)" />
          <rect x="64" y="64" width="896" height="896" rx="200" fill="none" stroke="#F3E8D8" strokeWidth="14" opacity="0.75" />

          <g transform="translate(512 512) scale(1.18) translate(-512 -512)">
            <g clipPath="url(#splash-clip)" opacity="0.38">
              <path d="M180 748 C250 720 310 742 360 718 C400 698 420 650 458 640 C486 632 502 652 512 640 C534 614 560 610 586 640 C610 668 642 656 666 676 C706 710 760 690 844 730 L844 860 L180 860 Z" fill="#0F0906" opacity="0.90" />
              <path d="M246 860 L282 700 L318 860 Z" fill="#F3E8D8" opacity="0.80" />
              <path d="M388 860 L426 682 L464 860 Z" fill="#F3E8D8" opacity="0.78" />
              <path d="M438 860 L470 708 L502 860 Z" fill="#F3E8D8" opacity="0.76" />
              <path d="M342 860 L368 760 L394 860 Z" fill="#C1A07A" opacity="0.72" />
              <path d="M538 860 L560 772 L582 860 Z" fill="#C1A07A" opacity="0.68" />
              <path d="M422 860 L450 730 L478 860 Z" fill="#AE8D67" opacity="0.92" />
              <path d="M246 860 L282 700 L282 860 Z" fill="#1A120B" opacity="0.22" />
              <path d="M388 860 L426 682 L426 860 Z" fill="#1A120B" opacity="0.20" />
              <path d="M438 860 L470 708 L470 860 Z" fill="#1A120B" opacity="0.18" />
            </g>

            <circle cx="512" cy="512" r="310" fill="none" stroke="#0F0906" strokeWidth="22" opacity="0.16" />
            <circle cx="512" cy="512" r="310" fill="none" stroke="#F3E8D8" strokeWidth="14" opacity="0.20" />
            <circle cx="512" cy="512" r="240" fill="none" stroke="#0F0906" strokeWidth="16" opacity="0.14" />
            <circle cx="512" cy="512" r="240" fill="none" stroke="#F3E8D8" strokeWidth="10" opacity="0.12" />

            <g stroke="#C1A07A" strokeWidth="10" strokeLinecap="round" opacity="0.32">
              <path d="M512 210V270" /><path d="M512 754V814" /><path d="M210 512H270" /><path d="M754 512H814" />
              <path d="M708 316l-40 40" /><path d="M316 708l-40 40" /><path d="M316 316l40 40" /><path d="M708 708l40 40" />
            </g>

            <g fill="none" stroke="url(#splash-accent)" strokeWidth="18" strokeLinecap="round" strokeLinejoin="round" opacity="0.95">
              <path d="M320 620 L430 520 L520 600 L640 460 L730 540" />
              <path d="M430 520 L420 390 L540 360 L640 460" />
              <path d="M520 600 L520 740" />
            </g>

            <g transform="translate(359,585) rotate(137.7) scale(2.70)" opacity="0.95">
              <path d="M0 0 L-22 10 L-22 -10 Z" fill="none" stroke="#0F0906" strokeWidth="2.2" strokeLinejoin="round" opacity="0.55" />
              <path d="M0 0 L-26 14 L-26 -14 Z" fill="#1A120B" opacity="0.28" />
              <path d="M0 0 L-22 10 L-22 -10 Z" fill="#F3E8D8" />
            </g>

            <g fill="#F3E8D8" opacity="0.98">
              <circle cx="320" cy="620" r="15" /><circle cx="430" cy="520" r="15" /><circle cx="520" cy="600" r="15" /><circle cx="640" cy="460" r="15" />
              <circle cx="730" cy="540" r="15" /><circle cx="420" cy="390" r="15" /><circle cx="540" cy="360" r="15" /><circle cx="520" cy="740" r="15" />
            </g>
          </g>
        </g>

        <text
          x="500" y="1120"
          fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial"
          fontSize="140" fontWeight="800" letterSpacing="2"
          textAnchor="middle"
          fill="#F3E8D8"
        >
          StalagMight
        </text>
      </svg>

      {/* Loading dots */}
      <div className="flex gap-1.5 mt-6" aria-label="Loading">
        <span className="splash-dot" style={{ animationDelay: '0ms' }} />
        <span className="splash-dot" style={{ animationDelay: '150ms' }} />
        <span className="splash-dot" style={{ animationDelay: '300ms' }} />
      </div>

      {/* Version */}
      <div
        className="absolute bottom-6 text-xs"
        style={{ color: 'var(--cc-text-secondary)' }}
      >
        v0.0.8
      </div>
    </div>
  );
}
