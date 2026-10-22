import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SectionHeader } from './SectionHeader';

describe('SectionHeader', () => {
  it('titles the section as an h2 and carries the actions it is given', () => {
    render(
      <SectionHeader title="Projects" busy={false} actions={<button>New project</button>} />
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Projects' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New project' })).toBeTruthy();
  });

  it('shows a skeleton instead of the title until the screen is ready', () => {
    render(<SectionHeader title="Projects" busy />);

    expect(screen.queryByText('Projects')).toBeNull();
  });
});
