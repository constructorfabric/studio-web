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

  it('puts the description beside the title in the header', () => {
    render(<SectionHeader title="Workspaces" busy={false} description="2 workspaces · 5 projects" />);

    const title = screen.getByRole('heading', { level: 2, name: 'Workspaces' });
    expect(title.parentElement?.contains(screen.getByText('2 workspaces · 5 projects'))).toBe(true);
  });

  it('draws no description line when it is given none', () => {
    render(<SectionHeader title="Workspaces" busy={false} />);

    expect(screen.getByRole('heading', { level: 2 }).parentElement?.childElementCount).toBe(1);
  });

  it('shows a skeleton instead of the title until the screen is ready', () => {
    render(<SectionHeader title="Projects" busy />);

    expect(screen.queryByText('Projects')).toBeNull();
  });
});
