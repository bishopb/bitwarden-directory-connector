import { JWT } from 'google-auth-library';
import {
    admin_directory_v1,
    google,
} from 'googleapis';

import { DirectoryType } from '../enums/directoryType';

import { GroupEntry } from '../models/groupEntry';
import { GSuiteConfiguration } from '../models/gsuiteConfiguration';
import { SyncConfiguration } from '../models/syncConfiguration';
import { UserEntry } from '../models/userEntry';

import { BaseDirectoryService } from './baseDirectory.service';
import { ConfigurationService } from './configuration.service';
import { DirectoryService } from './directory.service';

import { I18nService } from 'jslib/abstractions/i18n.service';
import { LogService } from 'jslib/abstractions/log.service';

export class GSuiteDirectoryService extends BaseDirectoryService implements DirectoryService {
    private client: JWT;
    private service: admin_directory_v1.Admin;
    private authParams: any;
    private dirConfig: GSuiteConfiguration;
    private syncConfig: SyncConfiguration;

    constructor(private configurationService: ConfigurationService, private logService: LogService,
        private i18nService: I18nService) {
        super();
        this.service = google.admin('directory_v1');
    }

    async getEntries(force: boolean, test: boolean): Promise<[GroupEntry[], UserEntry[]]> {
        const type = await this.configurationService.getDirectoryType();
        if (type !== DirectoryType.GSuite) {
            return;
        }

        this.dirConfig = await this.configurationService.getDirectory<GSuiteConfiguration>(DirectoryType.GSuite);
        if (this.dirConfig == null) {
            return;
        }

        this.syncConfig = await this.configurationService.getSync();
        if (this.syncConfig == null) {
            return;
        }

        await this.auth();

        let users: UserEntry[];
        if (this.syncConfig.users) {
            users = await this.getUsers();
        }

        let groups: GroupEntry[];
        if (this.syncConfig.groups) {
            const setFilter = this.createCustomSet(this.syncConfig.groupFilter);
            groups = await this.getGroups(setFilter);
            users = this.filterUsersFromGroupsSet(users, groups, setFilter);
        }

        return [groups, users];
    }

    private async getUsers(): Promise<UserEntry[]> {
        const entries: UserEntry[] = [];
        const query = this.createDirectoryQuery(this.syncConfig.userFilter);

        this.logService.info('Querying users.');
        let p = Object.assign({ query: query }, this.authParams);
        const res = await this.service.users.list(p);
        if (res.status !== 200) {
            throw new Error('User list API failed: ' + res.statusText);
        }

        const filter = this.createCustomSet(this.syncConfig.userFilter);
        if (res.data.users != null) {
            for (const user of res.data.users) {
                if (this.filterOutResult(filter, user.primaryEmail)) {
                    continue;
                }

                const entry = this.buildUser(user, false);
                if (entry != null) {
                    entries.push(entry);
                }
            }
        }

        this.logService.info('Querying deleted users.');
        p = Object.assign({ showDeleted: true, query: query }, this.authParams);
        const delRes = await this.service.users.list(p);
        if (delRes.status !== 200) {
            throw new Error('Deleted user list API failed: ' + delRes.statusText);
        }

        if (delRes.data.users != null) {
            for (const user of delRes.data.users) {
                if (this.filterOutResult(filter, user.primaryEmail)) {
                    continue;
                }

                const entry = this.buildUser(user, true);
                if (entry != null) {
                    entries.push(entry);
                }
            }
        }

        return entries;
    }

    private buildUser(user: admin_directory_v1.Schema$User, deleted: boolean) {
        if ((user.emails == null || user.emails === '') && !deleted) {
            return null;
        }

        const entry = new UserEntry();
        entry.referenceId = user.id;
        entry.externalId = user.id;
        entry.email = user.primaryEmail != null ? user.primaryEmail.trim().toLowerCase() : null;
        entry.disabled = user.suspended || false;
        entry.deleted = deleted;
        return entry;
    }

    private async getGroups(setFilter: [boolean, Set<string>]): Promise<GroupEntry[]> {
        const entries: GroupEntry[] = [];
        let nextPageToken;
        let p = Object.assign({});

        while(true) {
            this.logService.info('Querying groups - nextPageToken:' + nextPageToken);

            p = Object.assign({ pageToken: nextPageToken }, this.authParams);
            const res = await this.service.groups.list(p);
            nextPageToken = res.data.nextPageToken;

            if (res.status !== 200) {
                throw new Error('Group list API failed: ' + res.statusText);
            }
            if (res.data.groups != null) {
                for (const group of res.data.groups) {
                    if (!this.filterOutResult(setFilter, group.name)) {
                        const entry = await this.buildGroup(group);
                        entries.push(entry);
                    }
                }
            }
            if (nextPageToken == null) {
                break;
            }
        }

        return entries;
    }

    private async buildGroup(group: admin_directory_v1.Schema$Group) {
        const entry = new GroupEntry();
        entry.referenceId = group.id;
        entry.externalId = group.id;
        entry.name = group.name;

        const p = Object.assign({ groupKey: group.id }, this.authParams);
        const memRes = await this.service.members.list(p);
        if (memRes.status !== 200) {
            this.logService.warning('Group member list API failed: ' + memRes.statusText);
            return entry;
        }

        if (memRes.data.members != null) {
            for (const member of memRes.data.members) {
                if (member.type == null) {
                    continue;
                }
                if (member.role == null || member.role.toLowerCase() !== 'member') {
                    continue;
                }
                if (member.status == null || member.status.toLowerCase() !== 'active') {
                    continue;
                }

                const type = member.type.toLowerCase();
                if (type === 'user') {
                    entry.userMemberExternalIds.add(member.id);
                } else if (type === 'group') {
                    entry.groupMemberReferenceIds.add(member.id);
                }
            }
        }

        return entry;
    }

    private async auth() {
        if (this.dirConfig.clientEmail == null || this.dirConfig.privateKey == null ||
            this.dirConfig.adminUser == null || this.dirConfig.domain == null) {
            throw new Error(this.i18nService.t('dirConfigIncomplete'));
        }

        this.client = new google.auth.JWT({
            email: this.dirConfig.clientEmail,
            key: this.dirConfig.privateKey,
            subject: this.dirConfig.adminUser,
            scopes: [
                'https://www.googleapis.com/auth/admin.directory.user.readonly',
                'https://www.googleapis.com/auth/admin.directory.group.readonly',
                'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
            ],
        });

        await this.client.authorize();

        this.authParams = {
            auth: this.client,
            domain: this.dirConfig.domain,
        };
        if (this.dirConfig.customer != null) {
            this.authParams.customer = this.dirConfig.customer;
        }
    }
}
