import type { AuthRuntime } from '@gears-frontx/react';

declare module '@gears-frontx/framework/types' {
  interface FrontXAppRuntimeExtensions {
    auth?: AuthRuntime;
  }
}
