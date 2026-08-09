/**
 * Pairing approval. Spec sections 8 and 26.
 *
 * Connecting Studio is the one moment that genuinely deserves to interrupt the
 * user: approving it hands an agent control of their open place. The code is
 * shown large because the entire point is that they compare it against what
 * Studio is displaying.
 */
import { ShieldCheck } from "lucide-react";
import type { PairingRequest } from "@luumen/code-protocol";
import { BrandMark } from "@/components/Brand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function PairingDialog({ request }: { request: PairingRequest | null }): React.JSX.Element {
  return (
    <Dialog open={request !== null}>
      <DialogContent onEscapeKeyDown={(event) => event.preventDefault()} onInteractOutside={(event) => event.preventDefault()}>
        {request && (
          <>
            <DialogHeader>
              <div className="mb-1 grid size-9 place-items-center rounded-lg bg-primary/12">
                <BrandMark className="size-4.5" />
              </div>
              <DialogTitle>Connect to Roblox Studio?</DialogTitle>
              <DialogDescription>
                <b className="font-medium text-foreground">{request.place.name}</b> wants to let Luu Code inspect and
                change it.
              </DialogDescription>
            </DialogHeader>

            <div className="my-4 rounded-lg border bg-muted/40 py-3 text-center">
              <div className="font-mono text-[28px] leading-none font-semibold tracking-[0.22em] text-primary">
                {request.code}
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">Studio should be showing this code</div>
            </div>

            <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-muted-foreground">
              <ShieldCheck className="mt-px size-3.5 shrink-0" />
              Only approve if the codes match. Once connected, the agent can read and change scripts, run the game, and
              send input to it.
            </p>

            <div className="mt-4 flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => void window.luuCode.rejectPairing(request.sessionId)}>
                Decline
              </Button>
              <Button className="flex-1" onClick={() => void window.luuCode.approvePairing(request.sessionId)}>
                Approve
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
