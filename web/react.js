export let React;

export let h;

export let ViewBoundary;

export function initializeReact(value) {
  React = value;
  h = React.createElement;
  ViewBoundary = class extends React.Component {
    constructor(props) {
      super(props);
      this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
      return { error };
    }

    componentDidCatch(error) {
      // eslint-disable-next-line no-console
      console.error('[cc-memory] memory view crashed:', error);
    }

    render() {
      if (this.state.error !== null) {
        const error = this.state.error;
        const message = error && error.message ? error.message : String(error);
        return h(
          'div',
          { style: { padding: '18px 22px', font: 'inherit' }, 'data-cc-memory-error': '1' },
          h('div', { style: { fontWeight: 600, marginBottom: 8, fontSize: 14 } }, 'Memory 视图渲染失败 / Memory view failed to render'),
          h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12, opacity: 0.85, margin: 0 } }, message),
          h(
            'button',
            {
              type: 'button',
              style: { marginTop: 12, padding: '4px 12px', cursor: 'pointer' },
              onClick: () => this.setState({ error: null }),
            },
            'Retry / 重试',
          ),
        );
      }
      return this.props.children;
    }
  };
}
