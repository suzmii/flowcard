import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { copyText } from "@/lib/utils";

export function CopyButton({
  value,
  label = "复制",
  size = "xs",
  variant = "outline",
  className,
}: {
  value: string;
  label?: string;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied && !failed) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [copied, failed]);

  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      title={failed ? `复制失败：${value}` : value}
      onClick={() => {
        void copyText(value).then((ok) => {
          setCopied(ok);
          setFailed(!ok);
        });
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "已复制" : failed ? "复制失败" : label}
    </Button>
  );
}
