import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { JsonViewer } from './JsonViewer';

describe('JsonViewer', () => {
  it('should render primitive string values', () => {
    render(<JsonViewer data="hello" />);
    expect(screen.getByText(/"hello"/)).toBeDefined();
  });

  it('should render primitive number values', () => {
    render(<JsonViewer data={42} />);
    expect(screen.getByText('42')).toBeDefined();
  });

  it('should render boolean values', () => {
    render(<JsonViewer data={true} />);
    expect(screen.getByText('true')).toBeDefined();
  });

  it('should render null values', () => {
    render(<JsonViewer data={null} />);
    expect(screen.getByText('null')).toBeDefined();
  });

  it('should render object keys and values', () => {
    render(<JsonViewer data={{ name: 'Alice', age: 30 }} />);
    expect(screen.getByText(/"name"/)).toBeDefined();
    expect(screen.getByText(/"Alice"/)).toBeDefined();
    expect(screen.getByText('30')).toBeDefined();
  });

  it('should collapse nodes when clicking the toggle', () => {
    render(<JsonViewer data={{ key: 'value' }} />);
    const toggle = screen.getByLabelText('Toggle object');
    fireEvent.click(toggle);
    expect(screen.getByText(/1 item/)).toBeDefined();
  });

  it('should start collapsed when collapsed prop is true', () => {
    render(<JsonViewer data={{ a: 1, b: 2 }} collapsed />);
    expect(screen.getByText(/2 items/)).toBeDefined();
  });

  it('should render arrays correctly', () => {
    render(<JsonViewer data={[1, 2, 3]} />);
    expect(screen.getByText('1')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
  });

  it('should apply custom className', () => {
    render(<JsonViewer data={{}} className="mt-4" />);
    expect(screen.getByTestId('json-viewer').className).toContain('mt-4');
  });
});
