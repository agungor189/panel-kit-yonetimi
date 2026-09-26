import type { ReactNode } from 'react';
import { cn } from '../ui';

export function PageContainer({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto w-full max-w-[1600px] flex-1 p-4 md:p-6', className)}>
      {children}
    </div>
  );
}
