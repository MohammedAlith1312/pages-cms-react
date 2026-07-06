
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Loader } from "lucide-react";

export function SubmitButton({ loading, ...props }: any) {
  const { pending } = useFormStatus();
  const isPending = loading || pending;

  return (
    <Button {...props} type="submit" disabled={props.disabled || isPending}>
      {props.children}
      {isPending && <Loader className="size-4 animate-spin" />}
    </Button>
  );
}
