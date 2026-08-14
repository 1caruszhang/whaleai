import type { ComponentProps } from 'react';

import SettingsPage from './settings/SettingsPage';
import XiaojingConnectionSettings from './settings/XiaojingConnectionSettings';

type SettingsProps = ComponentProps<typeof SettingsPage>;

export default function Settings(props: SettingsProps) {
    if ((props.mode ?? 'settings') === 'settings') {
        return <XiaojingConnectionSettings />;
    }
    return <SettingsPage {...props} />;
}
