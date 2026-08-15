import { Nav } from "./sections/Nav";
import { Hero } from "./sections/Hero";
import { Capabilities } from "./sections/Capabilities";
import { Playtest } from "./sections/Playtest";
import { Agents } from "./sections/Agents";
import { Access } from "./sections/Access";
import { Mcp } from "./sections/Mcp";
import { Close } from "./sections/Close";
import { Footer } from "./sections/Footer";

export function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Rule />
        <Capabilities />
        <Rule />
        <Playtest />
        <Rule />
        <Agents />
        <Rule />
        <Access />
        <Mcp />
        <Close />
      </main>
      <Footer />
    </>
  );
}

/** Section break. Fades at both ends so it never reads as a boxed-in edge. */
function Rule() {
  return (
    <div aria-hidden className="mx-auto max-w-[1180px] px-6">
      <div className="via-border h-px bg-gradient-to-r from-transparent to-transparent" />
    </div>
  );
}
