import React from "@theia/core/shared/react";
interface Props {
    value: boolean;
    onChange: (value: boolean) => Promise<void>;
}
export function CatalogueGrouping({ value, onChange }: Props): React.ReactElement {
    const [error, setError] = React.useState<string>();
    const [pending, setPending] = React.useState<boolean>();
    const request = React.useRef(0) as {
        current: number;
    };
    React.useEffect(() => {
        if (pending === value)
            setPending(undefined);
    }, [pending, value]);
    return <div className="gbx-catalogue-grouping">
    <label><input type="checkbox" data-group-plugins checked={pending ?? value} onChange={event => {
            const next = event.currentTarget.checked;
            const token = ++request.current;
            setError(undefined);
            // Show the click immediately; the shared setting reconciles both surfaces.
            setPending(next);
            void onChange(next).catch(reason => {
                if (request.current !== token)
                    return;
                setPending(undefined);
                setError(String(reason));
            });
        }}/> Group plugins</label>
    {error && <span role="alert">Could not save the catalogue view: {error}</span>}
  </div>;
}
