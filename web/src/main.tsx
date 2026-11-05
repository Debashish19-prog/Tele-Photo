import '@/engine/polyfills';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import { ApiError } from '@/api';
import { ToastProvider } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SPRING } from '@/lib/motion';
import '@/index.css';

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    // A session can end at any time. Asking again takes the app back to the sign-in page.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) void queryClient.invalidateQueries({ queryKey: ['session'] });
    },
  }),
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* reducedMotion="user" follows the system setting for people who get ill from animation. */}
      <MotionConfig reducedMotion="user" transition={SPRING}>
        <ToastProvider limit={3}>
          <TooltipProvider delay={350}>
            <App />
          </TooltipProvider>
        </ToastProvider>
      </MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);
