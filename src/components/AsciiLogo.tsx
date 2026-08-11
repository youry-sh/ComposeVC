import React from "react";

/**
 * COMPOSEVC as an ASCII banner.
 *
 * Deliberately plain: one <pre> and a single slow sway. No water line, no
 * reflection, no blur — those needed a backdrop-filter that repainted the
 * whole empty chat on every frame.
 */

const BANNER = [
  " ██████╗ ██████╗ ███╗   ███╗██████╗  ██████╗ ███████╗███████╗██╗   ██╗ ██████╗",
  "██╔════╝██╔═══██╗████╗ ████║██╔══██╗██╔═══██╗██╔════╝██╔════╝██║   ██║██╔════╝",
  "██║     ██║   ██║██╔████╔██║██████╔╝██║   ██║███████╗█████╗  ██║   ██║██║     ",
  "██║     ██║   ██║██║╚██╔╝██║██╔═══╝ ██║   ██║╚════██║██╔══╝  ╚██╗ ██╔╝██║     ",
  "╚██████╗╚██████╔╝██║ ╚═╝ ██║██║     ╚██████╔╝███████║███████╗ ╚████╔╝ ╚██████╗",
  " ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝      ╚═════╝ ╚══════╝╚══════╝  ╚═══╝   ╚═════╝",
].join("\n");

const AsciiLogo: React.FC = () => (
  <div className="ascii-logo" aria-label="ComposeVC" role="img">
    <pre className="ascii-logo-art">{BANNER}</pre>
  </div>
);

export default AsciiLogo;
