/**
 * TextLoader Component - Prevents flash of untranslated content
 *
 * This component is part of your application's L4 layer (user code).
 * It was moved from @gears-frontx/react to allow direct dependency on UI components.
 */

import React from 'react';
import { useTranslation } from '@gears-frontx/react';
import { Skeleton } from '@gears-frontx/ui-kit/skeleton';

export interface TextLoaderProps {
  /** Child content to render when translations are loaded */
  children: React.ReactNode;
  /** Fallback while loading (alternative to skeleton) */
  fallback?: React.ReactNode;
  /**
   * Optional className for the skeleton loader
   * Use this to match the expected size of the text
   * @example "h-8 w-48" for a heading
   * @example "h-4 w-32" for a button label
   */
  skeletonClassName?: string;
  /** Optional className for the wrapper div */
  className?: string;
}

/**
 * TextLoader Component
 *
 * Generic wrapper for translated text that automatically shows a skeleton loader
 * while translations are being loaded. This eliminates the need for manual
 * loading state checks throughout the application.
 *
 * @example
 * ```tsx
 * // Heading — skeleton painted from --muted
 * <TextLoader skeletonClassName="h-10 w-64">
 *   <h1 className="text-4xl font-bold">{t('screen.title')}</h1>
 * </TextLoader>
 * ```
 */
export const TextLoader: React.FC<TextLoaderProps> = ({
  children,
  fallback,
  skeletonClassName,
  className,
}) => {
  const { language } = useTranslation();

  // If no language is set yet, show loading state
  if (!language) {
    // If fallback provided, use it
    if (fallback !== undefined) {
      return <>{fallback}</>;
    }

    // Otherwise, use skeleton
    if (skeletonClassName) {
      return <Skeleton className={skeletonClassName} />;
    }

    // Default: return nothing
    return null;
  }

  // If className is provided, wrap in div, otherwise return children directly
  if (className) {
    return <div className={className}>{children}</div>;
  }

  return <>{children}</>;
};
